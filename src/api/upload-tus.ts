/**
 * @fileoverview TUS resumable upload protocol implementation.
 *
 * Implements the TUS protocol (https://tus.io/) for resumable file uploads
 * using Cloudflare Durable Objects with SQLite storage for state management.
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User } from '../types';
import { TUS_VERSION, TUS_MAX_SIZE, TUS_EXTENSIONS, type CreateUploadResult, type UploadPartResult } from '../durable/TusUploadHandler';

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
	hideFromList: z.preprocess((v) => String(v).toLowerCase() === 'true', z.boolean().optional()),
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
 */
function getUploadStub(env: Env, uploadId: string) {
	const id = env.TUS_UPLOAD_HANDLER.idFromName(uploadId);
	return env.TUS_UPLOAD_HANDLER.get(id);
}

/**
 * Builds custom metadata for R2 from TUS metadata.
 */
function buildR2Metadata(meta: TusMetadata, fileId: string): Record<string, string> {
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
 */
export async function handleTusOptions(c: Context): Promise<Response> {
	return new Response(null, { status: 204, headers: TUS_HEADERS });
}

/**
 * Handles TUS upload creation (POST).
 */
export async function handleTusUploadCreation(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { config, logger } = env;
	const user = c.get('user');

	logger.info('[TUS] Upload creation requested', {
		uploader: user.email,
		sub: user.sub,
		roles: user.roles,
	});

	// Validate required headers
	const validatedHeaders = tusCreationHeadersSchema.safeParse({
		'upload-length': req.header('Upload-Length'),
		'upload-metadata': req.header('Upload-Metadata'),
	});

	if (!validatedHeaders.success) {
		logger.error('[TUS] Invalid headers', {
			errors: validatedHeaders.error.flatten(),
			headers: {
				'upload-length': req.header('Upload-Length'),
				'upload-metadata': req.header('Upload-Metadata'),
			},
		});
		throw new HTTPException(400, {
			message: 'Invalid TUS headers',
			cause: validatedHeaders.error,
		});
	}

	const { 'upload-length': uploadLength, 'upload-metadata': metadataHeader } = validatedHeaders.data;

	logger.debug('[TUS] Parsed headers', { uploadLength, metadataHeader });

	// Validate upload size
	if (uploadLength > TUS_MAX_SIZE) {
		logger.warn('[TUS] Upload too large', {
			size: uploadLength,
			max: TUS_MAX_SIZE,
			user: user.email,
		});
		throw new HTTPException(413, {
			message: `Upload exceeds maximum size of ${TUS_MAX_SIZE / 1024 / 1024 / 1024}GB`,
		});
	}

	// Parse and validate metadata
	const parsedMeta = parseTusMetadata(metadataHeader ?? '');
	logger.debug('[TUS] Parsed metadata', { parsedMeta });

	const validatedMeta = tusMetadataSchema.safeParse(parsedMeta);

	if (!validatedMeta.success) {
		logger.error('[TUS] Invalid Upload-Metadata', {
			errors: validatedMeta.error.flatten(),
			parsedMeta,
		});
		throw new HTTPException(400, {
			message: 'Invalid Upload-Metadata',
			cause: validatedMeta.error,
		});
	}

	const meta = validatedMeta.data;

	// Generate unique upload ID
	const uploadId = crypto.randomUUID();
	const r2Key = `${uploadId}/${meta.filename}`;

	logger.info('[TUS] Creating upload', {
		uploadId,
		filename: meta.filename,
		size: uploadLength,
		uploader: user.email,
		ownerId: user.sub,
		r2Key,
		metadata: meta,
	});

	// Create upload via Durable Object
	const stub = getUploadStub(env, uploadId);

	try {
		const result: CreateUploadResult = await stub.createUpload({
			r2Key,
			totalSize: uploadLength,
			filename: meta.filename,
			contentType: meta.contentType,
			customMetadata: buildR2Metadata(meta, uploadId),
			ownerId: user.sub, // FIX: Pass ownerId to Durable Object
		});

		logger.info('[TUS] Upload created successfully', {
			uploadId,
			action: result.action,
			uploadedSize: result.uploadedSize,
			expiresAt: result.expiresAt,
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

		return new Response(null, { status: 201, headers });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logger.error(
			'[TUS] Failed to create upload',
			{
				uploadId,
				error: errorMessage,
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		throw new HTTPException(500, {
			message: 'Failed to create upload',
			cause: error,
		});
	}
}

/**
 * Handles TUS chunk upload (PATCH).
 */
export async function handleTusUploadChunk(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { logger } = env;
	const user = c.get('user');

	// Validate parameters
	const { fileId: uploadId } = fileIdParamSchema.parse(req.param());
	const { 'upload-offset': clientOffset } = uploadOffsetSchema.parse(req.header());

	logger.debug('[TUS] Chunk upload request', {
		uploadId,
		clientOffset,
		user: user.email,
	});

	// Get Durable Object stub
	const stub = getUploadStub(env, uploadId);

	// Check current status first
	const status = await stub.getUploadStatus();
	if (!status) {
		logger.error('[TUS] Upload not found', { uploadId, user: user.email });
		throw new HTTPException(404, { message: 'Upload not found.' });
	}

	logger.debug('[TUS] Current upload status', {
		uploadId,
		uploadedSize: status.uploadedSize,
		totalSize: status.totalSize,
		isCompleted: status.isCompleted,
	});

	// Validate offset
	if (clientOffset !== status.uploadedSize) {
		logger.warn('[TUS] Offset mismatch', {
			uploadId,
			clientOffset,
			serverOffset: status.uploadedSize,
			user: user.email,
		});
		throw new HTTPException(409, {
			message: `Offset mismatch: expected ${status.uploadedSize}`,
		});
	}

	// If already completed, return current state
	if (status.isCompleted) {
		logger.info('[TUS] Upload already completed', { uploadId });
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

	logger.info('[TUS] Uploading chunk', {
		uploadId,
		chunkSize: body.byteLength,
		currentOffset: clientOffset,
		progress: `${((clientOffset / status.totalSize) * 100).toFixed(2)}%`,
	});

	// Upload chunk via Durable Object
	try {
		const result: UploadPartResult = await stub.uploadPart(clientOffset, body);

		logger.info('[TUS] Chunk uploaded successfully', {
			uploadId,
			newOffset: result.uploadedSize,
			isCompleted: result.isCompleted,
			progress: `${((result.uploadedSize / status.totalSize) * 100).toFixed(2)}%`,
		});

		// If completed, verify D1 entry was created
		if (result.isCompleted) {
			logger.info('[TUS] Upload completed, verifying D1 entry', { uploadId });

			// Wait a moment for D1 write to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			try {
				const { results } = await env.DB.prepare('SELECT id, filename, size FROM files WHERE id = ?').bind(uploadId).all();

				if (results && results.length > 0) {
					logger.info('[TUS] D1 entry verified', {
						uploadId,
						fileData: results[0],
					});
				} else {
					logger.error('[TUS] D1 entry NOT FOUND after completion', {
						uploadId,
						criticalError: true,
					});
				}
			} catch (dbError) {
				logger.error('[TUS] Failed to verify D1 entry', {
					uploadId,
					error: dbError instanceof Error ? dbError.message : 'Unknown error',
				});
			}
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
		logger.error(
			'[TUS] Chunk upload failed',
			{
				uploadId,
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

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
 */
export async function handleTusUploadHead(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { logger } = env;

	const { fileId: uploadId } = fileIdParamSchema.parse(req.param());

	logger.debug('[TUS] HEAD request', { uploadId });

	// Get status from Durable Object
	const stub = getUploadStub(env, uploadId);
	const status = await stub.getUploadStatus();

	if (!status) {
		logger.warn('[TUS] Upload not found for HEAD', { uploadId });
		throw new HTTPException(404, { message: 'Upload not found.' });
	}

	logger.debug('[TUS] Status retrieved', {
		uploadId,
		uploadedSize: status.uploadedSize,
		totalSize: status.totalSize,
		isCompleted: status.isCompleted,
	});

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
 */
export async function handleTusUploadDelete(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { logger } = env;

	const { fileId: uploadId } = fileIdParamSchema.parse(req.param());

	logger.info('[TUS] DELETE request', { uploadId });

	// Delete via Durable Object
	const stub = getUploadStub(env, uploadId);

	try {
		await stub.deleteUpload();
		logger.info('[TUS] Upload deleted successfully', { uploadId });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.debug('[TUS] Delete may have failed (possibly already deleted)', {
			uploadId,
			error: message,
		});
	}

	return new Response(null, { status: 204, headers: TUS_HEADERS });
}
