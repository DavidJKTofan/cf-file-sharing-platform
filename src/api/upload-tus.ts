// src/api/upload-tus.ts
// TUS handlers for Cloudflare Workers + R2 + KV
import { Env } from '../types';

type UploadPartRecord = { partNumber: number; etag: string; size: number; offset: number };

interface TusUploadMetadata {
	fileId: string;
	filename: string;
	description?: string;
	tags?: string;
	expiration?: string; // ISO string
	checksum?: string;
	hideFromList?: boolean;
	requiredRole?: string | null;
	totalSize: number;
	contentType?: string;
	uploadedAt: string;
	uploadId?: string;
	parts: UploadPartRecord[];
	completedSize: number;
	isCompleted: boolean;
	uploadType?: string;
}

const CORS_HEADERS_BASE: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, HEAD, PATCH, DELETE, OPTIONS',
	'Access-Control-Allow-Headers':
		'Upload-Length, Upload-Metadata, Upload-Offset, Tus-Resumable, Upload-Checksum, Content-Type, Authorization, cf-access-jwt-assertion',
	'Access-Control-Expose-Headers': 'Upload-Offset, Location, Upload-Length, Tus-Resumable, Upload-Metadata, Upload-Expires',
	'Tus-Resumable': '1.0.0',
	'Tus-Version': '1.0.0',
	'Tus-Max-Size': '5368709120',
	'Tus-Extension': 'creation,expiration,checksum,termination',
};

function corsHeaders(): Record<string, string> {
	return { ...CORS_HEADERS_BASE };
}

/** Basic base64 heuristic and decoding helpers (robust) */
function base64ToUtf8Maybe(input: string): string {
	if (!input || typeof input !== 'string') return input;
	try {
		const trimmed = input.replace(/\s+/g, '');
		// quick base64 character check
		if (trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+\/=]+$/.test(trimmed)) return input;
		const bin = atob(trimmed);
		let percentEncoded = '';
		for (let i = 0; i < bin.length; i++) {
			const code = bin.charCodeAt(i);
			percentEncoded += '%' + ('00' + code.toString(16)).slice(-2);
		}
		try {
			return decodeURIComponent(percentEncoded);
		} catch {
			return bin;
		}
	} catch {
		return input;
	}
}

/**
 * Parse Upload-Metadata header according to TUS spec:
 *  key base64value, key2 base64value2
 *
 * This function is defensive: it decodes once, tries a second decode only when sensible,
 * and returns the best textual candidate.
 */
function parseTusMetadata(metadataHeader: string | null): Record<string, string> {
	const metadata: Record<string, string> = {};
	if (!metadataHeader) return metadata;

	const pairs = metadataHeader.split(',');
	for (const rawPair of pairs) {
		const pair = rawPair.trim();
		if (!pair) continue;
		const firstSpace = pair.indexOf(' ');
		if (firstSpace <= 0) continue;
		const key = pair.slice(0, firstSpace).trim();
		const b64 = pair.slice(firstSpace + 1).trim();
		if (!b64) {
			metadata[key] = '';
			continue;
		}

		// decode once (expected)
		let decoded = base64ToUtf8Maybe(b64);

		// If decoded looks exactly like a SHA-256 hex digest, accept it as-is.
		if (/^[0-9a-f]{64}$/i.test(decoded)) {
			metadata[key] = decoded;
			continue;
		}

		// Otherwise, only attempt a second base64 decode if decoded itself looks base64,
		// and only accept the second decode if it's plausibly textual (mostly printable).
		const compact = decoded.replace(/\s+/g, '');
		if (/^[A-Za-z0-9+\/=]+$/.test(compact) && decoded.length % 4 === 0) {
			const twice = base64ToUtf8Maybe(decoded);
			const printableCount = twice.replace(/[^\x20-\x7E]/g, '').length;
			const printableRatio = twice.length > 0 ? printableCount / twice.length : 0;
			if (printableRatio > 0.6) {
				decoded = twice;
			}
		}

		metadata[key] = decoded;
	}
	return metadata;
}

function normalizeParsedMeta(parsed: Record<string, string>) {
	const p: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed)) p[k.toLowerCase()] = v;
	const filename = p.filename || p.name || p.originalname || p['file-name'] || '';
	const description = p.description || p.desc || '';
	const tags = p.tags || p.taglist || '';
	const expiration = p.expiration || p.expires || '';
	const hideFromList = p.hidefromlist || p.hide || '';
	const contentType = p.contenttype || p['content-type'] || '';
	const checksum = p.checksum || p.sha256 || '';
	const requiredRole = p.requiredrole || p['required_role'] || p['required-role'] || '';
	return { filename, description, tags, expiration, hideFromList, contentType, checksum, requiredRole };
}

async function getTusMetadataKV(env: Env, fileId: string): Promise<TusUploadMetadata | null> {
	if (!env.FILE_METADATA) return null;
	const raw = await env.FILE_METADATA.get(`tus:${fileId}`);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as TusUploadMetadata;
	} catch {
		return null;
	}
}

async function putTusMetadataKV(env: Env, fileId: string, meta: TusUploadMetadata) {
	if (!env.FILE_METADATA) return;
	await env.FILE_METADATA.put(`tus:${fileId}`, JSON.stringify(meta));
}

// OPTIONS handler
export async function handleTusOptions(_request?: Request): Promise<Response> {
	const headers = corsHeaders();
	return new Response(null, { status: 204, headers });
}

// Creation (POST) handler — includes CF/userAgent and uploadType in customMetadata
export async function handleTusUploadCreation(request: Request, env: Env): Promise<Response> {
	const headersOut = corsHeaders();
	try {
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headersOut });
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: headersOut });

		const tusResumable = request.headers.get('Tus-Resumable');
		if (!tusResumable) return new Response('Tus-Resumable header required', { status: 412, headers: headersOut });

		const uploadLengthHeader = request.headers.get('Upload-Length');
		if (!uploadLengthHeader) return new Response('Upload-Length header required', { status: 400, headers: headersOut });
		const totalSize = parseInt(uploadLengthHeader, 10);
		if (isNaN(totalSize) || totalSize < 0) return new Response('Invalid Upload-Length', { status: 400, headers: headersOut });

		const uploadMetadataHeader = request.headers.get('Upload-Metadata') || '';
		const parsedRaw = parseTusMetadata(uploadMetadataHeader);
		const parsed = normalizeParsedMeta(parsedRaw);

		if (!parsed.filename) return new Response('Filename required in Upload-Metadata', { status: 400, headers: headersOut });

		let expirationIso: string | undefined;
		if (parsed.expiration) {
			const dt = new Date(parsed.expiration);
			if (isNaN(dt.getTime()) || dt <= new Date()) {
				return new Response('Invalid expiration (must be future ISO datetime)', { status: 400, headers: headersOut });
			}
			expirationIso = dt.toISOString();
		}

		if (env.MAX_TOTAL_FILE_SIZE) {
			const maxAllowed = parseInt(String(env.MAX_TOTAL_FILE_SIZE), 10);
			if (!isNaN(maxAllowed) && maxAllowed > 0 && totalSize > maxAllowed) {
				return new Response('File exceeds maximum allowed size', { status: 413, headers: headersOut });
			}
		}

		const fileId = crypto.randomUUID();
		const objectKey = `${fileId}/${parsed.filename}`;

		if (!env.R2_FILES) {
			console.error('R2_FILES binding missing; storage not configured.');
			return new Response('Storage backend not configured', { status: 500, headers: headersOut });
		}

		// Collect CF + UA metadata
		const cf = (request as any).cf || {};
		const userAgent = request.headers.get('user-agent') || '';

		const customMetadata: Record<string, string> = {
			fileId,
			description: parsed.description || '',
			tags: parsed.tags || '',
			expiration: expirationIso || '',
			checksum: parsed.checksum || '',
			originalName: parsed.filename,
			uploadedAt: new Date().toISOString(),
			hideFromList: parsed.hideFromList || '',
			requiredRole: parsed.requiredRole || '',
			uploadType: 'tus',
			asn: (cf.asn ? String(cf.asn) : '') || '',
			country: cf.country || '',
			city: cf.city || '',
			timezone: cf.timezone || '',
			userAgent: userAgent || '',
		};

		// Create multipart upload and embed customMetadata
		let uploadId: string | undefined;
		try {
			const multipart = await (env as any).R2_FILES.createMultipartUpload(objectKey, {
				httpMetadata: {
					contentType: parsed.contentType || 'application/octet-stream',
					contentDisposition: `attachment; filename="${parsed.filename}"`,
				},
				customMetadata,
			});
			uploadId = multipart.uploadId;
		} catch (err) {
			console.error('Failed to create R2 multipart upload', err);
			return new Response('Failed to initialize upload', { status: 500, headers: headersOut });
		}

		const meta: TusUploadMetadata = {
			fileId,
			filename: parsed.filename,
			description: parsed.description,
			tags: parsed.tags,
			expiration: expirationIso,
			checksum: parsed.checksum,
			hideFromList: parsed.hideFromList === 'true' || parsed.hideFromList === '1',
			requiredRole: parsed.requiredRole || null,
			totalSize,
			contentType: parsed.contentType,
			uploadedAt: new Date().toISOString(),
			uploadId,
			parts: [],
			completedSize: 0,
			isCompleted: false,
			uploadType: 'tus',
		};

		if (!env.FILE_METADATA) {
			console.warn('FILE_METADATA KV not configured; will not persist tus metadata.');
		} else {
			try {
				await putTusMetadataKV(env, fileId, meta);
			} catch (err) {
				console.error('Failed to persist TUS metadata to KV', err);
				return new Response('Failed to initialize upload metadata', { status: 500, headers: headersOut });
			}
		}

		const urlOrigin = new URL(request.url).origin;
		const location = `${urlOrigin}/api/upload/tus/${fileId}`;

		headersOut['Location'] = location;
		headersOut['Upload-Expires'] = meta.expiration ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

		return new Response(null, { status: 201, headers: headersOut });
	} catch (err) {
		console.error('TUS creation error', err);
		return new Response('Internal server error', { status: 500, headers: corsHeaders() });
	}
}

// PATCH handler — on completion write final `file:${fileId}` metadata (includes uploadType and requiredRole)
export async function handleTusUploadChunk(request: Request, env: Env, fileId: string): Promise<Response> {
	const headersOut = corsHeaders();
	try {
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headersOut });
		if (request.method !== 'PATCH') return new Response('Method not allowed', { status: 405, headers: headersOut });

		const tusResumable = request.headers.get('Tus-Resumable');
		if (!tusResumable) return new Response('Tus-Resumable header required', { status: 412, headers: headersOut });

		const uploadOffsetHeader = request.headers.get('Upload-Offset');
		if (uploadOffsetHeader === null) return new Response('Upload-Offset header required', { status: 400, headers: headersOut });
		const clientOffset = parseInt(uploadOffsetHeader, 10);
		if (isNaN(clientOffset) || clientOffset < 0) return new Response('Invalid Upload-Offset', { status: 400, headers: headersOut });

		const meta = await getTusMetadataKV(env, fileId);
		if (!meta) {
			console.warn(`TUS PATCH: metadata missing for fileId=${fileId}`);
			return new Response('Upload not found', { status: 404, headers: headersOut });
		}

		if (meta.isCompleted) return new Response('Upload already completed', { status: 410, headers: headersOut });

		if (meta.expiration && new Date(meta.expiration) <= new Date())
			return new Response('Upload expired', { status: 410, headers: headersOut });

		if (clientOffset !== meta.completedSize) {
			headersOut['Upload-Offset'] = String(meta.completedSize);
			return new Response('Upload offset mismatch', { status: 409, headers: headersOut });
		}

		const body = await request.arrayBuffer();
		const chunkSize = body.byteLength;
		if (chunkSize === 0) {
			return new Response(null, { status: 204, headers: { ...headersOut, 'Upload-Offset': String(meta.completedSize) } });
		}

		if (!env.R2_FILES || !meta.uploadId) {
			console.error('R2 binding or uploadId missing for chunk append');
			return new Response('Storage backend not configured', { status: 500, headers: headersOut });
		}

		const objectKey = `${fileId}/${meta.filename}`;
		const nextPartNumber = (meta.parts.length > 0 ? meta.parts[meta.parts.length - 1].partNumber : 0) + 1;

		let uploadPartResult: any;
		try {
			const multipart = (env as any).R2_FILES.resumeMultipartUpload(objectKey, meta.uploadId);
			uploadPartResult = await multipart.uploadPart(nextPartNumber, body);
		} catch (err) {
			console.error('uploadPart failed', err);
			return new Response('Failed to upload part', { status: 500, headers: headersOut });
		}

		const etag = uploadPartResult?.etag ?? uploadPartResult?.ETag ?? uploadPartResult?.eTag ?? `part-${nextPartNumber}`;

		const partRecord: UploadPartRecord = {
			partNumber: nextPartNumber,
			etag,
			size: chunkSize,
			offset: meta.completedSize,
		};
		meta.parts.push(partRecord);
		meta.completedSize += chunkSize;

		try {
			await putTusMetadataKV(env, fileId, meta);
		} catch (err) {
			console.warn('Failed to persist TUS progress to KV', err);
		}

		// Complete if sizes match
		if (meta.completedSize === meta.totalSize) {
			try {
				const completionParts = meta.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
				const multipart = (env as any).R2_FILES.resumeMultipartUpload(objectKey, meta.uploadId);
				const completedObj = await multipart.complete(completionParts);

				meta.isCompleted = true;

				// Build final metadata record (persist under file:${fileId})
				const origin = new URL(request.url).origin;
				const finalMetaRecord: Record<string, any> = {
					success: true,
					fileId: meta.fileId,
					filename: meta.filename,
					size: meta.totalSize,
					contentType: meta.contentType,
					description: meta.description,
					tags: meta.tags,
					expiration: meta.expiration,
					hideFromList: meta.hideFromList,
					requiredRole: meta.requiredRole || null,
					uploadedAt: meta.uploadedAt,
					r2Key: objectKey,
					r2ETag: completedObj?.httpEtag ?? completedObj?.etag ?? completedObj?.ETag ?? '',
					downloadUrl: `${origin}/api/download/${fileId}`,
					uploadType: meta.uploadType || 'tus',
					checksum: meta.checksum || '',
				};

				// Persist final metadata under `file:${fileId}` for list/download handlers
				if (env.FILE_METADATA) {
					try {
						await env.FILE_METADATA.put(`file:${fileId}`, JSON.stringify(finalMetaRecord));
					} catch (err) {
						console.error('Failed to persist final file metadata to KV', err);
					}
				} else {
					console.warn('FILE_METADATA KV missing: final file metadata not persisted.');
				}
			} catch (err) {
				console.error('Failed to complete multipart upload', err);
				return new Response('Failed to finalize upload', { status: 500, headers: headersOut });
			}

			try {
				await putTusMetadataKV(env, fileId, meta);
			} catch (err) {
				console.warn('Failed to persist final TUS metadata', err);
			}
		}

		headersOut['Upload-Offset'] = String(meta.completedSize);
		headersOut['Upload-Length'] = String(meta.totalSize);

		return new Response(null, { status: 204, headers: headersOut });
	} catch (err) {
		console.error('TUS PATCH error', err);
		return new Response('Internal server error', { status: 500, headers: corsHeaders() });
	}
}

// HEAD handler
export async function handleTusUploadHead(_request: Request, env: Env, fileId: string): Promise<Response> {
	const headersOut = corsHeaders();
	try {
		const meta = await getTusMetadataKV(env, fileId);
		if (!meta) return new Response('Upload not found', { status: 404, headers: headersOut });
		if (meta.expiration && new Date(meta.expiration) <= new Date())
			return new Response('Upload expired', { status: 410, headers: headersOut });
		headersOut['Upload-Offset'] = String(meta.completedSize);
		headersOut['Upload-Length'] = String(meta.totalSize);
		headersOut['Cache-Control'] = 'no-store';
		return new Response(null, { status: 200, headers: headersOut });
	} catch (err) {
		console.error('TUS HEAD error', err);
		return new Response('Internal server error', { status: 500, headers: corsHeaders() });
	}
}

// DELETE handler
export async function handleTusUploadDelete(_request: Request, env: Env, fileId: string): Promise<Response> {
	const headersOut = corsHeaders();
	try {
		const meta = await getTusMetadataKV(env, fileId);
		if (!meta) return new Response('Upload not found', { status: 404, headers: headersOut });
		if (!meta.isCompleted && meta.uploadId && env.R2_FILES) {
			try {
				const multipart = (env as any).R2_FILES.resumeMultipartUpload(`${fileId}/${meta.filename}`, meta.uploadId);
				if (multipart && multipart.abort) {
					const maybePromise = multipart.abort();
					if (maybePromise instanceof Promise) await maybePromise;
				} else if ((env as any).R2_FILES.abortMultipartUpload) {
					await (env as any).R2_FILES.abortMultipartUpload(`${fileId}/${meta.filename}`, meta.uploadId);
				}
			} catch (err) {
				console.warn('Failed to abort multipart upload', err);
			}
		}
		if (env.FILE_METADATA) {
			try {
				await env.FILE_METADATA.delete(`tus:${fileId}`);
			} catch (err) {
				console.warn('Failed to delete tus metadata KV', err);
			}
		}
		return new Response(null, { status: 204, headers: headersOut });
	} catch (err) {
		console.error('TUS DELETE error', err);
		return new Response('Internal server error', { status: 500, headers: corsHeaders() });
	}
}
