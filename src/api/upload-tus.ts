/**
 * @fileoverview TUS resumable upload protocol implementation.
 *
 * Implements the TUS protocol (https://tus.io/) for resumable file uploads
 * using Cloudflare Durable Objects with SQLite storage for state management.
 *
 * Architecture:
 * - Each upload gets its own Durable Object instance
 * - Upload state is persisted in SQLite within the Durable Object
 * - Automatic cleanup via Durable Object alarms
 * - R2 multipart uploads for efficient large file handling
 *
 * Supported TUS extensions:
 * - creation: Create new uploads
 * - creation-with-upload: Create and upload in single request
 * - expiration: Uploads expire after 7 days
 * - termination: Cancel/delete uploads
 *
 * @module api/upload-tus
 * @see {@link https://tus.io/protocols/resumable-upload}
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User } from '../types';
import {
	TUS_VERSION,
	TUS_MAX_SIZE,
	TUS_EXTENSIONS,
	type CreateUploadResult,
	type UploadPartResult,
} from '../durable/TusUploadHandler';

// ============================================================================
// Constants
// ============================================================================

/** Standard TUS response headers */
const TUS_HEADERS: Record<string, string> = {
	'Tus-Resumable': TUS_VERSION,
	'Tus-Version': TUS_VERSION,
	'Tus-Max-Size': String(TUS_MAX_SIZE),
	'Tus-Extension': TUS_EXTENSIONS,
};

// ============================================================================
// Validation Schemas
// ============================================================================

/** Schema for TUS creation request headers */
const tusCreationHeadersSchema = z.object({
	'upload-length': z.coerce.number().int().positive({
		message: 'Upload-Length must be a positive integer',
	}),
	'upload-metadata': z.string().optional(),
});

/** Schema for parsed TUS metadata */
const tusMetadataSchema = z.object({
	filename: z.string().min(1, { message: 'Filename is required' }),
	contentType: z.string().optional(),
	description: z.string().max(1000).optional(),
	tags: z.string().max(500).optional(),
	expiration: z.string().optional(),
	checksum: z.string().max(128).optional(),
	hideFromList: z.preprocess(
		(v) => String(v).toLowerCase() === 'true',
		z.boolean().optional()
	),
	requiredRole: z.string().max(50).optional(),
});

/** Schema for file ID parameter */
const fileIdParamSchema = z.object({
	fileId: z.string().uuid({ message: 'Invalid file ID format' }),
});

/** Schema for upload offset header */
const uploadOffsetSchema = z.object({
	'upload-offset': z.coerce.number().int().nonnegative({
		message: 'Upload-Offset must be a non-negative integer',
	}),
});

// ============================================================================
// Types
// ============================================================================

/** Parsed TUS metadata from Upload-Metadata header */
type TusMetadata = z.infer<typeof tusMetadataSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parses TUS Upload-Metadata header.
 *
 * @remarks
 * The Upload-Metadata header contains comma-separated key-value pairs
 * where values are base64-encoded.
 *
 * Format: `key1 base64value1,key2 base64value2`
 *
 * @param metadataHeader - Raw Upload-Metadata header value
 * @returns Parsed metadata object
 */
function parseTusMetadata(metadataHeader: string): Record<string, string> {
	const metadata: Record<string, string> = {};

	if (!metadataHeader) {
		return metadata;
	}

	for (const pair of metadataHeader.split(',')) {
		const [key, value] = pair.trim().split(' ');
		if (!key || !value) {
			continue;
		}

		try {
			metadata[key] = atob(value);
		} catch {
			metadata[key] = value;
		}
	}

	return metadata;
}

/**
 * Gets or creates a Durable Object stub for an upload.
 *
 * @param env - Environment with DO namespace
 * @param uploadId - Upload identifier
 * @returns Durable Object stub
 */
function getUploadStub(env: Env, uploadId: string) {
	const id = env.TUS_UPLOAD_HANDLER.idFromName(uploadId);
	return env.TUS_UPLOAD_HANDLER.get(id);
}

/**
 * Builds custom metadata for R2 from TUS metadata.
 *
 * @param meta - Parsed TUS metadata
 * @param fileId - File identifier
 * @returns R2 custom metadata object
 */
function buildR2Metadata(
	meta: TusMetadata,
	fileId: string
): Record<string, string> {
	const result: Record<string, string> = {
		fileId,
		originalName: meta.filename,
		uploadType: 'tus',
		uploadedAt: new Date().toISOString(),
	};

	if (meta.description) result.description = meta.description;
	if (meta.tags) result.tags = meta.tags;
	if (meta.expiration) result.expiration = meta.expiration;
	if (meta.checksum) result.checksum = meta.checksum;
	if (meta.hideFromList !== undefined) result.hideFromList = String(meta.hideFromList);
	if (meta.requiredRole) result.requiredRole = meta.requiredRole;

	return result;
}

// ============================================================================
// TUS Handlers
// ============================================================================

/**
 * Handles TUS OPTIONS requests (CORS preflight).
 *
 * @param c - Hono context
 * @returns 204 No Content with TUS headers
 */
export async function handleTusOptions(c: Context): Promise<Response> {
	return new Response(null, { status: 204, headers: TUS_HEADERS });
}

/**
 * Handles TUS upload creation (POST).
 *
 * @remarks
 * Creates a new resumable upload session using Durable Objects:
 * 1. Validates Upload-Length and Upload-Metadata headers
 * 2. Creates Durable Object instance for upload state
 * 3. Initiates R2 multipart upload via DO
 * 4. Returns Location header with upload URL
 *
 * @param c - Hono context with environment bindings and user
 * @returns 201 Created with Location header
 *
 * @throws {HTTPException} 400 - Invalid headers or metadata
 * @throws {HTTPException} 413 - Upload too large
 */
export async function handleTusUploadCreation(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { req, env } = c;
	const { config, logger } = env;
	const user = c.get('user');

	logger.debug('TUS upload creation requested', { uploader: user.email });

	// Validate required headers
	const validatedHeaders = tusCreationHeadersSchema.safeParse({
		'upload-length': req.header('Upload-Length'),
		'upload-metadata': req.header('Upload-Metadata'),
	});

	if (!validatedHeaders.success) {
		logger.warn('Invalid TUS headers', { errors: validatedHeaders.error.flatten() });
		throw new HTTPException(400, {
			message: 'Invalid TUS headers',
			cause: validatedHeaders.error,
		});
	}

	const { 'upload-length': uploadLength, 'upload-metadata': metadataHeader } =
		validatedHeaders.data;

	// Validate upload size
	if (uploadLength > TUS_MAX_SIZE) {
		logger.warn('TUS upload too large', { size: uploadLength, max: TUS_MAX_SIZE });
		throw new HTTPException(413, {
			message: `Upload exceeds maximum size of ${TUS_MAX_SIZE / 1024 / 1024 / 1024}GB`,
		});
	}

	// Parse and validate metadata
	const parsedMeta = parseTusMetadata(metadataHeader ?? '');
	const validatedMeta = tusMetadataSchema.safeParse(parsedMeta);

	if (!validatedMeta.success) {
		logger.warn('Invalid Upload-Metadata', { errors: validatedMeta.error.flatten() });
		throw new HTTPException(400, {
			message: 'Invalid Upload-Metadata',
			cause: validatedMeta.error,
		});
	}

	const meta = validatedMeta.data;

	// Generate unique upload ID
	const uploadId = crypto.randomUUID();
	const r2Key = `${uploadId}/${meta.filename}`;

	logger.info('Creating TUS upload', {
		uploadId,
		filename: meta.filename,
		size: uploadLength,
		uploader: user.email,
	});

	// Create upload via Durable Object
	const stub = getUploadStub(env, uploadId);
	const result: CreateUploadResult = await stub.createUpload({
		r2Key,
		totalSize: uploadLength,
		filename: meta.filename,
		contentType: meta.contentType,
		customMetadata: buildR2Metadata(meta, uploadId),
	});

	// Build response headers
	const location = `${config.APP_URL}/api/upload/tus/${uploadId}`;
	const expiresAt = new Date(result.expiresAt).toISOString();

	const headers: Record<string, string> = {
		...TUS_HEADERS,
		Location: location,
		'Upload-Offset': '0',
		'Upload-Expires': expiresAt,
	};

	logger.debug('TUS upload created', {
		uploadId,
		location,
		action: result.action,
	});

	return new Response(null, { status: 201, headers });
}

/**
 * Handles TUS chunk upload (PATCH).
 *
 * @remarks
 * Uploads a chunk of file data via Durable Object:
 * 1. Validates Upload-Offset header matches server state
 * 2. Forwards chunk to Durable Object for R2 upload
 * 3. Returns new offset in response
 *
 * @param c - Hono context with environment bindings and user
 * @returns 204 No Content with Upload-Offset header
 *
 * @throws {HTTPException} 409 - Offset mismatch (resume required)
 * @throws {HTTPException} 404 - Upload not found
 */
export async function handleTusUploadChunk(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { req, env } = c;
	const { config, logger } = env;

	// Validate parameters
	const { fileId: uploadId } = fileIdParamSchema.parse(req.param());
	const { 'upload-offset': clientOffset } = uploadOffsetSchema.parse(req.header());

	logger.debug('TUS chunk upload', { uploadId, clientOffset });

	// Get Durable Object stub
	const stub = getUploadStub(env, uploadId);

	// Check current status first
	const status = await stub.getUploadStatus();
	if (!status) {
		logger.warn('TUS upload not found', { uploadId });
		throw new HTTPException(404, { message: 'Upload not found.' });
	}

	// Validate offset
	if (clientOffset !== status.uploadedSize) {
		logger.warn('TUS offset mismatch', {
			uploadId,
			clientOffset,
			serverOffset: status.uploadedSize,
		});
		throw new HTTPException(409, {
			message: `Offset mismatch: expected ${status.uploadedSize}`,
		});
	}

	// If already completed, return current state
	if (status.isCompleted) {
		return new Response(null, {
			status: 204,
			headers: {
				...TUS_HEADERS,
				'Upload-Offset': String(status.uploadedSize),
			},
		});
	}

	// Read chunk data
	const body = await req.arrayBuffer();

	logger.debug('Uploading chunk', {
		uploadId,
		chunkSize: body.byteLength,
		currentOffset: clientOffset,
	});

	// Upload chunk via Durable Object
	try {
		const result: UploadPartResult = await stub.uploadPart(clientOffset, body);

		// If completed, store final metadata in KV for fast lookups
		if (result.isCompleted && env.FILE_METADATA) {
			const r2Key = `${uploadId}/${status.uploadId}`; // Will need to get from DO
			await env.FILE_METADATA.put(
				`file:${uploadId}`,
				JSON.stringify({
					fileId: uploadId,
					size: status.totalSize,
					uploadType: 'tus',
					uploadedAt: new Date().toISOString(),
				})
			);
			logger.info('TUS upload completed', { uploadId, totalSize: status.totalSize });
		}

		return new Response(null, {
			status: 204,
			headers: {
				...TUS_HEADERS,
				'Upload-Offset': String(result.uploadedSize),
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Upload failed';
		logger.error('TUS chunk upload failed', { uploadId, error: message });

		if (message.includes('Offset mismatch')) {
			throw new HTTPException(409, { message });
		}
		if (message.includes('not found')) {
			throw new HTTPException(404, { message: 'Upload not found.' });
		}
		throw new HTTPException(500, { message: 'Upload failed.' });
	}
}

/**
 * Handles TUS upload status (HEAD).
 *
 * @remarks
 * Returns current upload state for resumption via Durable Object:
 * - Upload-Offset: Bytes uploaded so far
 * - Upload-Length: Total expected size
 *
 * @param c - Hono context with environment bindings and user
 * @returns 200 OK with upload status headers
 *
 * @throws {HTTPException} 404 - Upload not found
 */
export async function handleTusUploadHead(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { req, env } = c;
	const { logger } = env;

	const { fileId: uploadId } = fileIdParamSchema.parse(req.param());

	logger.debug('TUS HEAD request', { uploadId });

	// Get status from Durable Object
	const stub = getUploadStub(env, uploadId);
	const status = await stub.getUploadStatus();

	if (!status) {
		logger.warn('TUS upload not found for HEAD', { uploadId });
		throw new HTTPException(404, { message: 'Upload not found.' });
	}

	const headers: Record<string, string> = {
		...TUS_HEADERS,
		'Upload-Offset': String(status.uploadedSize),
		'Upload-Length': String(status.totalSize),
		'Cache-Control': 'no-store',
	};

	// Add expiration header if not completed
	if (!status.isCompleted) {
		headers['Upload-Expires'] = new Date(status.expiresAt).toISOString();
	}

	return new Response(null, { status: 200, headers });
}

/**
 * Handles TUS upload deletion (DELETE).
 *
 * @remarks
 * Cancels an in-progress upload via Durable Object:
 * 1. Aborts R2 multipart upload (if not completed)
 * 2. Clears Durable Object storage
 *
 * @param c - Hono context with environment bindings and user
 * @returns 204 No Content
 */
export async function handleTusUploadDelete(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { req, env } = c;
	const { logger } = env;

	const { fileId: uploadId } = fileIdParamSchema.parse(req.param());

	logger.debug('TUS DELETE request', { uploadId });

	// Delete via Durable Object
	const stub = getUploadStub(env, uploadId);

	try {
		await stub.deleteUpload();
		logger.info('TUS upload deleted', { uploadId });
	} catch (error) {
		// Log but don't fail - upload may already be deleted
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.debug('TUS delete may have failed (possibly already deleted)', {
			uploadId,
			error: message,
		});
	}

	return new Response(null, { status: 204, headers: TUS_HEADERS });
}
