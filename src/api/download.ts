/**
 * @fileoverview File download handler with presigned URL support.
 *
 * Provides secure file downloads with:
 * - Role-based access control
 * - Expiration checking
 * - Presigned URLs in production (reduces Worker egress)
 * - Direct streaming in development
 *
 * @module api/download
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

/** Presigned URL expiration time in seconds (10 minutes) */
const PRESIGNED_URL_EXPIRY_SECONDS = 600;

// ============================================================================
// Validation Schemas
// ============================================================================

/** Schema for download route parameters */
const downloadParamsSchema = z.object({
	fileId: z.string().uuid({ message: 'Invalid file ID format' }),
});

// ============================================================================
// Types
// ============================================================================

/** Combined metadata from R2 and KV */
interface FileMetadata {
	r2Key?: string;
	originalName?: string;
	requiredRole?: string;
	requiredrole?: string; // Legacy lowercase variant
	expiration?: string;
	checksum?: string;
	[key: string]: unknown;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetches file metadata from KV cache.
 *
 * @param env - Environment with KV binding
 * @param fileId - File identifier
 * @returns Parsed metadata or null if not found
 */
async function getKvMetadata(env: Env, fileId: string): Promise<FileMetadata | null> {
	if (!env.FILE_METADATA) {
		return null;
	}

	try {
		const raw = await env.FILE_METADATA.get(`file:${fileId}`);
		if (!raw) {
			return null;
		}
		return JSON.parse(raw) as FileMetadata;
	} catch {
		return null;
	}
}

/**
 * Resolves the R2 object key for a file.
 *
 * @param env - Environment with R2 binding
 * @param fileId - File identifier
 * @param kvMetadata - Optional cached metadata
 * @returns R2 object key
 * @throws {HTTPException} 404 if file not found
 */
async function resolveR2Key(
	env: Env,
	fileId: string,
	kvMetadata: FileMetadata | null
): Promise<string> {
	// Try KV cache first
	if (kvMetadata?.r2Key) {
		return kvMetadata.r2Key;
	}

	// Fall back to R2 list
	const list = await env.R2_FILES.list({ prefix: `${fileId}/`, limit: 1 });
	if (!list.objects.length) {
		throw new HTTPException(404, { message: 'File not found.' });
	}

	return list.objects[0].key;
}

/**
 * Validates user authorization to access a file.
 *
 * @param user - Current user (may be undefined for public access)
 * @param metadata - File metadata with access requirements
 * @throws {HTTPException} 403 if access denied
 */
function validateAccess(user: User | undefined, metadata: FileMetadata): void {
	const requiredRole = metadata.requiredRole ?? metadata.requiredrole;

	if (!requiredRole) {
		return; // No role required, public access allowed
	}

	const userRoles = user?.roles ?? [];
	const hasAccess = isAdmin(user) || userRoles.includes(requiredRole);

	if (!hasAccess) {
		throw new HTTPException(403, {
			message: 'Access denied. Required role not met.',
		});
	}
}

/**
 * Checks if a file has expired.
 *
 * @param metadata - File metadata with expiration
 * @throws {HTTPException} 410 if file has expired
 */
function validateExpiration(metadata: FileMetadata): void {
	if (!metadata.expiration) {
		return;
	}

	const expirationDate = new Date(metadata.expiration);
	if (expirationDate <= new Date()) {
		throw new HTTPException(410, { message: 'This file has expired.' });
	}
}

/**
 * Sanitizes a filename for use in HTTP headers.
 *
 * @param filename - Original filename
 * @returns Sanitized filename safe for Content-Disposition header
 */
function sanitizeFilename(filename: string): string {
	// Remove or replace unsafe characters
	return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ============================================================================
// Download Handler
// ============================================================================

/**
 * Handles file download requests.
 *
 * @remarks
 * Download behavior varies by environment:
 * - **Production**: Generates a presigned URL and redirects. This offloads
 *   bandwidth from the Worker and avoids egress fees.
 * - **Development**: Streams the file through the Worker. This is compatible
 *   with Wrangler's local development environment.
 *
 * @param c - Hono context with environment bindings and optional user
 * @returns Redirect response (production) or streamed file (development)
 *
 * @throws {HTTPException} 403 - Access denied (role requirement not met)
 * @throws {HTTPException} 404 - File not found
 * @throws {HTTPException} 410 - File has expired
 * @throws {HTTPException} 500 - R2 credentials not configured
 */
export async function handleDownload(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>
): Promise<Response> {
	const { env } = c;
	const { config, logger } = env;
	const user = c.get('user');

	// Validate and extract file ID
	const { fileId } = downloadParamsSchema.parse(c.req.param());

	logger.debug('Download requested', { fileId, userEmail: user?.email });

	// Fetch metadata from KV cache
	const kvMetadata = await getKvMetadata(env, fileId);

	// Resolve R2 object key
	const r2Key = await resolveR2Key(env, fileId, kvMetadata);

	// Get R2 object metadata
	const headObj = await env.R2_FILES.head(r2Key);
	if (!headObj) {
		logger.warn('File not found in R2', { fileId, r2Key });
		throw new HTTPException(404, { message: 'File not found in storage.' });
	}

	// Merge metadata from R2 and KV
	const metadata: FileMetadata = {
		...headObj.customMetadata,
		...kvMetadata,
	};

	// Validate access and expiration
	validateAccess(user, metadata);
	validateExpiration(metadata);

	// Production: Use presigned URL redirect
	if (config.ENVIRONMENT === 'production') {
		return handlePresignedDownload(c, r2Key, metadata);
	}

	// Development: Stream through Worker
	return handleStreamedDownload(c, r2Key, metadata);
}

/**
 * Generates a presigned URL and redirects the client.
 *
 * @param c - Hono context
 * @param r2Key - R2 object key
 * @param metadata - File metadata
 * @returns Redirect response to presigned URL
 */
async function handlePresignedDownload(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>,
	r2Key: string,
	metadata: FileMetadata
): Promise<Response> {
	const { env } = c;
	const { config, logger } = env;
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
	const { R2_ACCOUNT_ID, R2_BUCKET_NAME } = config;

	// Validate R2 credentials
	if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
		logger.error('R2 credentials not configured for presigned URLs');
		throw new HTTPException(500, {
			message: 'Download service temporarily unavailable.',
		});
	}

	logger.info('Generating presigned URL', {
		bucket: R2_BUCKET_NAME,
		key: r2Key,
	});

	// Create AWS client for signing
	const aws = new AwsClient({
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});

	// Build presigned URL
	const url = new URL(
		`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${r2Key}`
	);
	url.searchParams.set('X-Amz-Expires', String(PRESIGNED_URL_EXPIRY_SECONDS));

	const signedRequest = await aws.sign(url.href, {
		aws: { signQuery: true },
	});

	return c.redirect(signedRequest.url, 302);
}

/**
 * Streams the file directly through the Worker.
 *
 * @param c - Hono context
 * @param r2Key - R2 object key
 * @param metadata - File metadata
 * @returns Streamed file response
 */
async function handleStreamedDownload(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>,
	r2Key: string,
	metadata: FileMetadata
): Promise<Response> {
	const { env } = c;
	const { logger } = env;

	// Fetch the actual object
	const object = await env.R2_FILES.get(r2Key);
	if (!object) {
		logger.error('Failed to retrieve file data', { r2Key });
		throw new HTTPException(404, { message: 'File data could not be retrieved.' });
	}

	// Determine filename
	const originalName = metadata.originalName ?? r2Key.split('/').pop() ?? 'file';
	const filename = sanitizeFilename(originalName);

	logger.debug('Streaming file', { r2Key, filename, size: object.size });

	// Build response headers
	const headers = new Headers({
		'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
		'Content-Length': String(object.size),
		'Content-Disposition': `attachment; filename="${filename}"`,
		'Cache-Control': 'private, no-cache',
	});

	// Add optional headers
	if (object.httpEtag) {
		headers.set('ETag', object.httpEtag);
	}
	if (metadata.checksum) {
		headers.set('X-File-Checksum', metadata.checksum);
	}

	return new Response(object.body, { headers });
}
