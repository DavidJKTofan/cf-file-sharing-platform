// src/api/upload-tus.ts
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User } from '../types';

// --- Schemas ---
const tusCreationHeadersSchema = z.object({
	'upload-length': z.coerce.number().int().positive(),
	'upload-metadata': z.string().optional(),
});

const tusMetadataSchema = z.object({
	filename: z.string(),
	contentType: z.string().optional(),
	description: z.string().optional(),
	tags: z.string().optional(),
	expiration: z.string().optional(),
	checksum: z.string().optional(),
	hideFromList: z.preprocess((v) => String(v).toLowerCase() === 'true', z.boolean().optional()),
	requiredRole: z.string().optional(),
});

// --- Types ---
type UploadPartRecord = { partNumber: number; etag: string; size: number };

interface TusUploadMetadata extends z.infer<typeof tusMetadataSchema> {
	fileId: string;
	totalSize: number;
	uploadId: string;
	parts: UploadPartRecord[];
	completedSize: number;
	isCompleted: boolean;
	uploadedAt: string;
}

// --- KV Helpers ---
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
	await env.FILE_METADATA.put(`tus:${fileId}`, JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 * 7 }); // 7 days
}

// --- TUS Logic ---
function parseTusMetadata(metadataHeader: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	if (!metadataHeader) return metadata;
	metadataHeader.split(',').forEach((pair) => {
		const [key, value] = pair.split(' ');
		if (key && value) {
			try {
				metadata[key] = atob(value);
			} catch (e) {
				console.warn(`Failed to decode base64 metadata value for key '${key}'. Using raw value.`);
				metadata[key] = value;
			}
		}
	});
	return metadata;
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
	const { config } = env;

	if (config.ENVIRONMENT === 'development') {
		console.log('[DEBUG] TUS creation request received. Headers:', JSON.stringify(req.header(), null, 2));
	}

	const validatedHeaders = tusCreationHeadersSchema.safeParse({
		'upload-length': req.header('Upload-Length'),
		'upload-metadata': req.header('Upload-Metadata'),
	});

	if (!validatedHeaders.success) {
		throw new HTTPException(400, { message: 'Invalid TUS headers', cause: validatedHeaders.error });
	}

	const { 'upload-length': uploadLength, 'upload-metadata': metadataHeader } = validatedHeaders.data;
	const parsedMeta = parseTusMetadata(metadataHeader || '');
	const validatedMeta = tusMetadataSchema.safeParse(parsedMeta);

	if (!validatedMeta.success) {
		throw new HTTPException(400, { message: 'Invalid Upload-Metadata', cause: validatedMeta.error });
	}

	const { filename, contentType, ...restMeta } = validatedMeta.data;
	const fileId = crypto.randomUUID();
	const objectKey = `${fileId}/${filename}`;

	const stringMeta: Record<string, string> = {};
	for (const [key, value] of Object.entries(restMeta)) {
		if (value !== undefined) {
			stringMeta[key] = String(value);
		}
	}

	const multipartUpload = await env.R2_FILES.createMultipartUpload(objectKey, {
		httpMetadata: { contentType: contentType || 'application/octet-stream' },
		customMetadata: {
			...stringMeta,
			fileId,
			uploadType: 'tus',
			uploadedAt: new Date().toISOString(),
		},
	});

	const tusMetadata: TusUploadMetadata = {
		...validatedMeta.data,
		fileId,
		totalSize: uploadLength,
		uploadId: multipartUpload.uploadId,
		parts: [],
		completedSize: 0,
		isCompleted: false,
		uploadedAt: new Date().toISOString(),
	};

	if (env.FILE_METADATA) {
		if (config.ENVIRONMENT === 'development') {
			console.log('[DEBUG] Storing TUS metadata in KV:', JSON.stringify(tusMetadata, null, 2));
		}
		await putTusMetadataKV(env, fileId, tusMetadata);
	}

	const location = `${config.APP_URL}/api/upload/tus/${fileId}`;
	const headers = { ...TUS_HEADERS, Location: location };
	return new Response(null, { status: 201, headers });
}

// PATCH handler
export async function handleTusUploadChunk(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { config } = env;
	const { fileId } = z.object({ fileId: z.string().uuid() }).parse(req.param());
	const { 'upload-offset': clientOffset } = z.object({ 'upload-offset': z.coerce.number().int().nonnegative() }).parse(req.header());

	if (config.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] TUS chunk upload for fileId: ${fileId}. Headers:`, JSON.stringify(req.header(), null, 2));
	}

	const meta = await getTusMetadataKV(env, fileId);
	if (!meta || clientOffset !== meta.completedSize) {
		if (config.ENVIRONMENT === 'development') {
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

	if (meta.completedSize >= meta.totalSize) {
		if (config.ENVIRONMENT === 'development') {
			console.log(`[DEBUG] TUS upload complete for fileId: ${fileId}. Total size: ${meta.totalSize}`);
		}
		const completedParts = meta.parts.map((p: UploadPartRecord) => ({ partNumber: p.partNumber, etag: p.etag }));
		await multipart.complete(completedParts);
		meta.isCompleted = true;
		meta.completedSize = meta.totalSize; // Ensure it exactly matches

		if (env.FILE_METADATA) {
			await env.FILE_METADATA.put(
				`file:${fileId}`,
				JSON.stringify({
					...meta,
					size: meta.totalSize,
					uploadType: 'tus',
				})
			);
		}
	}

	await putTusMetadataKV(env, fileId, meta);

	const headers = { ...TUS_HEADERS, 'Upload-Offset': String(meta.completedSize) };
	return new Response(null, { status: 204, headers });
}

// HEAD handler
export async function handleTusUploadHead(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { config } = env;
	const { fileId } = z.object({ fileId: z.string().uuid() }).parse(req.param());

	if (config.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] TUS HEAD request for fileId: ${fileId}`);
	}

	const meta = await getTusMetadataKV(env, fileId);
	if (!meta) {
		throw new HTTPException(404, { message: 'Upload not found.' });
	}

	if (config.ENVIRONMENT === 'development') {
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
	const { config } = env;
	const { fileId } = z.object({ fileId: z.string().uuid() }).parse(req.param());

	if (config.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] TUS DELETE request for fileId: ${fileId}`);
	}

	const meta = await getTusMetadataKV(env, fileId);
	if (meta && !meta.isCompleted && meta.uploadId) {
		if (config.ENVIRONMENT === 'development') {
			console.log(`[DEBUG] Aborting multipart upload for fileId: ${fileId}, uploadId: ${meta.uploadId}`);
		}
		try {
			const multipart = env.R2_FILES.resumeMultipartUpload(`${fileId}/${meta.filename}`, meta.uploadId);
			await multipart.abort();
		} catch (error: any) {
			// R2 throws if the upload is already completed or aborted. We can safely ignore this.
			if (config.ENVIRONMENT === 'development') {
				console.warn(`[DEBUG] Failed to abort multipart upload (may already be completed/aborted): ${error.message}`);
			}
		}
	}

	if (env.FILE_METADATA) {
		await env.FILE_METADATA.delete(`tus:${fileId}`);
	}

	return new Response(null, { status: 204, headers: TUS_HEADERS });
}
