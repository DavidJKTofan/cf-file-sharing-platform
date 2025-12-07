/**
 * @fileoverview File download handler with presigned URL support.
 *
 * Provides secure file downloads with:
 * - Role-based access control
 * - Expiration checking
 * - Presigned URLs in production (reduces Worker egress)
 * - Direct streaming in development
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import { AwsClient } from 'aws4fetch';
import type { Env, User } from '../types';
import { isAdmin } from '../auth';

// ============================================================================
// Constants
// ============================================================================

// 10 minutes PreSigned URL expiry
const PRESIGNED_URL_EXPIRY_SECONDS = 600;

// ============================================================================
// Validation Schemas
// ============================================================================

const downloadParamsSchema = z.object({
	fileId: z.string().uuid({ message: 'Invalid file ID format' }),
});

// ============================================================================
// Types
// ============================================================================

interface FileMetadata {
	id: string;
	r2Key: string;
	filename: string;
	requiredRole: string | null;
	expiration: string | null;
	checksum: string | null;
	[key: string]: unknown;
}

// ============================================================================
// Helper Functions
// ============================================================================

async function getFileMetadataFromD1(env: Env, fileId: string): Promise<FileMetadata | null> {
	const { results } = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).all<FileMetadata>();
	if (!results || results.length === 0) {
		return null;
	}
	return results[0];
}

function validateAccess(user: User | undefined, metadata: FileMetadata): void {
	if (!metadata.requiredRole) {
		return; // Public access
	}
	if (isAdmin(user) || user?.roles.includes(metadata.requiredRole)) {
		return;
	}
	throw new HTTPException(403, { message: 'Access denied. Required role not met.' });
}

function validateExpiration(metadata: FileMetadata): void {
	if (metadata.expiration && new Date(metadata.expiration) <= new Date()) {
		throw new HTTPException(410, { message: 'This file has expired.' });
	}
}

function sanitizeFilename(filename: string): string {
	return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ============================================================================
// Download Handler
// ============================================================================

export async function handleDownload(c: Context<{ Bindings: Env; Variables: { user?: User } }>): Promise<Response> {
	const { env } = c;
	const { config, logger } = env;
	const user = c.get('user');

	const { fileId } = downloadParamsSchema.parse(c.req.param());
	logger.debug('[DOWNLOAD] Download requested', { fileId, userEmail: user?.email });

	const metadata = await getFileMetadataFromD1(env, fileId);
	if (!metadata) {
		logger.warn('[DOWNLOAD] File not found', { fileId });
		throw new HTTPException(404, { message: 'File not found.' });
	}

	logger.debug('[DOWNLOAD] File metadata retrieved', {
		fileId,
		filename: metadata.filename,
		r2Key: metadata.r2Key,
		requiredRole: metadata.requiredRole,
	});

	validateAccess(user, metadata);
	validateExpiration(metadata);

	// Check if we should use presigned URLs or streaming
	// FIX: Get R2 credentials from env secrets, not config
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID } = env;
	const hasR2Credentials = Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ACCOUNT_ID);

	logger.debug('[DOWNLOAD] Download method determination', {
		environment: config.ENVIRONMENT,
		hasR2Credentials,
		willUsePresigned: config.ENVIRONMENT === 'production' && hasR2Credentials,
	});

	if (config.ENVIRONMENT === 'production' && hasR2Credentials) {
		return handlePresignedDownload(c, metadata);
	}

	// Fall back to streaming (development or missing credentials)
	if (config.ENVIRONMENT === 'production' && !hasR2Credentials) {
		logger.warn('[DOWNLOAD] R2 credentials missing in production, falling back to streaming', {
			fileId,
		});
	}

	return handleStreamedDownload(c, metadata);
}

async function handlePresignedDownload(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>,
	metadata: FileMetadata
): Promise<Response> {
	const { env } = c;
	const { config, logger } = env;

	// FIX: Get credentials from env, not config
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID } = env;

	if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
		logger.error('[DOWNLOAD] R2 credentials not configured for presigned URLs', {
			hasAccountId: !!R2_ACCOUNT_ID,
			hasAccessKey: !!R2_ACCESS_KEY_ID,
			hasSecretKey: !!R2_SECRET_ACCESS_KEY,
		});
		throw new HTTPException(500, { message: 'Download service temporarily unavailable.' });
	}

	logger.info('[DOWNLOAD] Generating presigned URL', {
		key: metadata.r2Key,
		accountId: R2_ACCOUNT_ID.substring(0, 8) + '***', // Log partial ID for debugging
	});

	try {
		const aws = new AwsClient({
			accessKeyId: R2_ACCESS_KEY_ID,
			secretAccessKey: R2_SECRET_ACCESS_KEY,
			service: 's3',
			region: 'auto',
		});

		const url = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${config.R2_BUCKET_NAME}/${metadata.r2Key}`);
		url.searchParams.set('X-Amz-Expires', String(PRESIGNED_URL_EXPIRY_SECONDS));

		// Add response headers to force download with correct filename
		url.searchParams.set('response-content-disposition', `attachment; filename="${encodeURIComponent(metadata.filename)}"`);

		const signedRequest = await aws.sign(url.href, { aws: { signQuery: true } });

		logger.info('[DOWNLOAD] Presigned URL generated successfully', {
			fileId: metadata.id,
			expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
		});

		return c.redirect(signedRequest.url, 302);
	} catch (error) {
		logger.error(
			'[DOWNLOAD] Failed to generate presigned URL',
			{
				fileId: metadata.id,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		// Fall back to streaming on presigned URL failure
		logger.warn('[DOWNLOAD] Falling back to streaming due to presigned URL error');
		return handleStreamedDownload(c, metadata);
	}
}

async function handleStreamedDownload(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>,
	metadata: FileMetadata
): Promise<Response> {
	const { env } = c;
	const { logger } = env;

	logger.debug('[DOWNLOAD] Using streaming download', { r2Key: metadata.r2Key });

	try {
		const object = await env.R2_FILES.get(metadata.r2Key);
		if (!object) {
			logger.error('[DOWNLOAD] Failed to retrieve file from R2', {
				r2Key: metadata.r2Key,
				fileId: metadata.id,
			});
			throw new HTTPException(404, { message: 'File data could not be retrieved.' });
		}

		const filename = sanitizeFilename(metadata.filename);
		logger.info('[DOWNLOAD] Streaming file', {
			r2Key: metadata.r2Key,
			filename,
			size: object.size,
			fileId: metadata.id,
		});

		const headers = new Headers({
			'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'Content-Length': String(object.size),
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'private, no-cache',
		});

		if (object.httpEtag) headers.set('ETag', object.httpEtag);
		if (metadata.checksum) headers.set('X-File-Checksum', metadata.checksum);

		return new Response(object.body, { headers });
	} catch (error) {
		logger.error(
			'[DOWNLOAD] Streaming download failed',
			{
				fileId: metadata.id,
				r2Key: metadata.r2Key,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		throw error;
	}
}
