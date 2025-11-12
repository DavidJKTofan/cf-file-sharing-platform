// src/api/upload-tus.ts
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { Env, User } from '../types';

type UploadPartRecord = { partNumber: number; etag: string; size: number };

interface TusUploadMetadata {
	fileId: string;
	filename: string;
	description?: string;
	tags?: string;
	expiration?: string;
	checksum?: string;
	hideFromList?: boolean;
	requiredRole?: string;
	totalSize: number;
	contentType?: string;
	uploadedAt: string;
	uploadId: string;
	parts: UploadPartRecord[];
	completedSize: number;
	isCompleted: boolean;
}

function parseTusMetadata(metadataHeader: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	if (!metadataHeader) return metadata;
	metadataHeader.split(',').forEach((pair) => {
		const [key, value] = pair.split(' ');
		if (key && value) {
			try {
				metadata[key] = atob(value);
			} catch (e) {
				metadata[key] = value; // Fallback for non-base64 values
			}
		}
	});
	return metadata;
}

async function getTusMetadataKV(env: Env, fileId: string): Promise<TusUploadMetadata | null> {
	if (!env.FILE_METADATA) return null;
	const raw = await env.FILE_METADATA.get(`tus:${fileId}`);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function putTusMetadataKV(env: Env, fileId: string, meta: TusUploadMetadata) {
	if (!env.FILE_METADATA) return;
	await env.FILE_METADATA.put(`tus:${fileId}`, JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 * 7 });
}

const TUS_HEADERS = {
	'Tus-Resumable': '1.0.0',
	'Tus-Version': '1.0.0',
	'Tus-Max-Size': String(5 * 1024 * 1024 * 1024), // 5GB
	'Tus-Extension': 'creation,expiration,checksum,termination',
};

// OPTIONS handler
export async function handleTusOptions(c: Context): Promise<Response> {
	return new Response(null, { status: 204, headers: TUS_HEADERS });
}

// Creation (POST) handler
export async function handleTusUploadCreation(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;

	if (env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] TUS creation request received. Headers:', JSON.stringify(req.header(), null, 2));
	}

	const uploadLength = parseInt(req.header('Upload-Length') || '', 10);
	if (isNaN(uploadLength) || uploadLength <= 0) {
		throw new HTTPException(400, { message: 'Valid Upload-Length header is required.' });
	}

	const metadataHeader = req.header('Upload-Metadata') || '';
	const metadata = parseTusMetadata(metadataHeader);
	if (env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] Parsed TUS metadata:', JSON.stringify(metadata, null, 2));
	}
	const filename = metadata.filename || metadata.name;
	if (!filename) {
		throw new HTTPException(400, { message: 'Filename is required in Upload-Metadata.' });
	}

	const fileId = crypto.randomUUID();
	const objectKey = `${fileId}/${filename}`;

	const multipartUpload = await env.R2_FILES.createMultipartUpload(objectKey, {
		httpMetadata: { contentType: metadata.contentType || 'application/octet-stream' },
		customMetadata: {
			...metadata,
			fileId,
			uploadType: 'tus',
			uploadedAt: new Date().toISOString(),
		},
	});

	const tusMetadata: TusUploadMetadata = {
		fileId,
		filename,
		totalSize: uploadLength,
		uploadId: multipartUpload.uploadId,
		parts: [],
		completedSize: 0,
		isCompleted: false,
		uploadedAt: new Date().toISOString(),
		...metadata,
	};

	if (env.FILE_METADATA) {
		if (env.ENVIRONMENT === 'development') {
			console.log('[DEBUG] Storing TUS metadata in KV:', JSON.stringify(tusMetadata, null, 2));
		}
		await putTusMetadataKV(env, fileId, tusMetadata);
	}

	const location = `${new URL(req.url).origin}/api/upload/tus/${fileId}`;
	const headers = { ...TUS_HEADERS, Location: location };
	return new Response(null, { status: 201, headers });
}

// PATCH handler
export async function handleTusUploadChunk(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const fileId = req.param('fileId');

	if (env.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] TUS chunk upload for fileId: ${fileId}. Headers:`, JSON.stringify(req.header(), null, 2));
	}

	const clientOffset = parseInt(req.header('Upload-Offset') || '', 10);
	if (isNaN(clientOffset)) {
		throw new HTTPException(400, { message: 'Valid Upload-Offset header is required.' });
	}

	const meta = await getTusMetadataKV(env, fileId);
	if (!meta || clientOffset !== meta.completedSize) {
		if (env.ENVIRONMENT === 'development') {
			console.error(`[DEBUG] TUS offset mismatch. Client: ${clientOffset}, Server: ${meta?.completedSize}`);
		}
		throw new HTTPException(409, { message: 'Upload offset mismatch.' });
	}

	if (meta.isCompleted) {
		return new Response(null, { status: 204, headers: { ...TUS_HEADERS, 'Upload-Offset': String(meta.completedSize) } });
	}

	const body = await req.arrayBuffer();
	const partNumber = meta.parts.length + 1;
	const objectKey = `${fileId}/${meta.filename}`;

	const multipart = env.R2_FILES.resumeMultipartUpload(objectKey, meta.uploadId);
	const uploadedPart = await multipart.uploadPart(partNumber, body);

	meta.parts.push({ partNumber, etag: uploadedPart.etag, size: body.byteLength });
	meta.completedSize += body.byteLength;

	if (meta.completedSize === meta.totalSize) {
		if (env.ENVIRONMENT === 'development') {
			console.log(`[DEBUG] TUS upload complete for fileId: ${fileId}. Total size: ${meta.totalSize}`);
		}
		const completedParts = meta.parts.map((p: UploadPartRecord) => ({ partNumber: p.partNumber, etag: p.etag }));
		await multipart.complete(completedParts);
		meta.isCompleted = true;

		if (env.FILE_METADATA) {
			await env.FILE_METADATA.put(
				`file:${fileId}`,
				JSON.stringify({
					size: meta.totalSize,
					contentType: meta.contentType,
					uploadType: 'tus',
					...meta,
				}),
			);
		}
	}

	if (env.FILE_METADATA) {
		await putTusMetadataKV(env, fileId, meta);
	}

	const headers = { ...TUS_HEADERS, 'Upload-Offset': String(meta.completedSize) };
	return new Response(null, { status: 204, headers });
}

// HEAD handler
export async function handleTusUploadHead(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const fileId = req.param('fileId');

	if (env.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] TUS HEAD request for fileId: ${fileId}`);
	}

	const meta = await getTusMetadataKV(env, fileId);
	if (!meta) {
		throw new HTTPException(404, { message: 'Upload not found.' });
	}

	if (env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] TUS HEAD response metadata:', JSON.stringify(meta, null, 2));
	}

	const headers = {
		...TUS_HEADERS,
		'Upload-Offset': String(meta.completedSize),
		'Upload-Length': String(meta.totalSize),
		'Cache-Control': 'no-store',
	};
	return new Response(null, { status: 200, headers });
}

// DELETE handler
export async function handleTusUploadDelete(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const fileId = req.param('fileId');

	if (env.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] TUS DELETE request for fileId: ${fileId}`);
	}

	const meta = await getTusMetadataKV(env, fileId);
	if (meta && !meta.isCompleted && meta.uploadId) {
		if (env.ENVIRONMENT === 'development') {
			console.log(`[DEBUG] Aborting multipart upload for fileId: ${fileId}, uploadId: ${meta.uploadId}`);
		}
		const multipart = env.R2_FILES.resumeMultipartUpload(`${fileId}/${meta.filename}`, meta.uploadId);
		await multipart.abort();
	}

	if (env.FILE_METADATA) {
		await env.FILE_METADATA.delete(`tus:${fileId}`);
	}

	return new Response(null, { status: 204, headers: TUS_HEADERS });
}
