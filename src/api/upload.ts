/**
 * @fileoverview File upload handler for direct multipart uploads.
 *
 * Handles single-file uploads via multipart/form-data. For large files,
 * use the TUS resumable upload protocol instead.
 *
 * @module api/upload
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User, CfProperties, FileCustomMetadata } from '../types';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Schema for validating upload form data.
 *
 * @remarks
 * All fields except `file` are optional metadata that can be attached
 * to the uploaded file.
 */
const uploadFormSchema = z.object({
	/** The file to upload (required) */
	file: z.instanceof(File, { message: 'A file is required' }),
	/** Optional description of the file */
	description: z.string().max(1000).optional(),
	/** Optional comma-separated tags */
	tags: z.string().max(500).optional(),
	/** Optional expiration date (ISO 8601 format) */
	expiration: z.string().optional(),
	/** Optional checksum for integrity verification */
	checksum: z.string().max(128).optional(),
	/** Whether to hide from public file listings */
	hideFromList: z
		.string()
		.transform((s) => s.toLowerCase() === 'true')
		.optional(),
	/** Role required to access this file */
	requiredRole: z.string().max(50).optional(),
});

/** Inferred type from upload form schema */
type UploadFormData = z.infer<typeof uploadFormSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validates and parses an expiration date string.
 *
 * @param expiration - ISO 8601 date string
 * @returns Parsed Date object or null if no expiration
 * @throws {HTTPException} If date is invalid or in the past
 */
function parseExpirationDate(expiration: string | undefined): Date | null {
	if (!expiration) {
		return null;
	}

	const date = new Date(expiration);
	if (isNaN(date.getTime())) {
		throw new HTTPException(400, {
			message: 'Invalid expiration date format. Use ISO 8601 format.',
		});
	}

	if (date <= new Date()) {
		throw new HTTPException(400, {
			message: 'Expiration date must be in the future.',
		});
	}

	return date;
}

/**
 * Extracts Cloudflare request properties for metadata.
 *
 * @param req - Raw request object
 * @returns Cloudflare properties or empty defaults
 */
function extractCfProperties(req: Request): CfProperties {
	const cf = (req as unknown as { cf?: CfProperties }).cf;
	return cf ?? {};
}

/**
 * Formats file size for human-readable display.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "10.5 MB")
 */
function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ============================================================================
// Upload Handler
// ============================================================================

/**
 * Handles direct file uploads via multipart/form-data.
 *
 * @remarks
 * This handler is for smaller files that can be uploaded in a single request.
 * For large files (>100MB), use the TUS resumable upload protocol.
 *
 * @param c - Hono context with environment bindings and user
 * @returns JSON response with file metadata and download URL
 *
 * @throws {HTTPException} 400 - Invalid content type or form data
 * @throws {HTTPException} 413 - File exceeds maximum size
 */
export async function handleUpload(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { req, env } = c;
	const { config, logger } = env;
	const user = c.get('user');

	// Validate content type
	const contentType = req.header('content-type') ?? '';
	if (!contentType.includes('multipart/form-data')) {
		logger.warn('Invalid content type for upload', { contentType });
		throw new HTTPException(400, {
			message: 'Invalid content type. Expected multipart/form-data.',
		});
	}

	// Parse and validate form data
	const formData = await req.formData();
	const validated = uploadFormSchema.safeParse({
		file: formData.get('file'),
		description: formData.get('description'),
		tags: formData.get('tags'),
		expiration: formData.get('expiration'),
		checksum: formData.get('checksum'),
		hideFromList: formData.get('hideFromList'),
		requiredRole: formData.get('requiredRole'),
	});

	if (!validated.success) {
		logger.debug('Upload validation failed', { errors: validated.error.flatten() });
		throw new HTTPException(400, {
			message: 'Invalid form data',
			cause: validated.error,
		});
	}

	const { file, description, tags, expiration, checksum, hideFromList, requiredRole } =
		validated.data;

	// Validate file size
	if (file.size > config.MAX_TOTAL_FILE_SIZE) {
		const maxSize = formatFileSize(config.MAX_TOTAL_FILE_SIZE);
		logger.warn('File size exceeds limit', {
			fileSize: file.size,
			maxSize: config.MAX_TOTAL_FILE_SIZE,
		});
		throw new HTTPException(413, {
			message: `File exceeds maximum allowed size of ${maxSize}.`,
		});
	}

	// Parse expiration date
	const expirationDate = parseExpirationDate(expiration);

	// Generate unique file ID and R2 object key
	const fileId = crypto.randomUUID();
	const objectKey = `${fileId}/${file.name}`;

	// Extract Cloudflare request properties for metadata
	const cf = extractCfProperties(req.raw);

	// Build custom metadata for R2 object
	const customMetadata: FileCustomMetadata = {
		fileId,
		description: description ?? '',
		tags: tags ?? '',
		expiration: expirationDate?.toISOString() ?? '',
		checksum: checksum ?? '',
		originalName: file.name,
		uploadedAt: new Date().toISOString(),
		hideFromList: String(hideFromList ?? false),
		requiredRole: requiredRole ?? '',
		uploadType: 'multipart',
		asn: String(cf.asn ?? ''),
		country: cf.country ?? '',
		city: cf.city ?? '',
		timezone: cf.timezone ?? '',
		userAgent: req.header('User-Agent') ?? '',
	};

	logger.info('Uploading file', {
		fileId,
		filename: file.name,
		size: file.size,
		contentType: file.type,
		uploader: user.email,
	});

	// Upload to R2
	await env.R2_FILES.put(objectKey, file.stream(), {
		httpMetadata: { contentType: file.type || 'application/octet-stream' },
		customMetadata: customMetadata as unknown as Record<string, string>,
	});

	const downloadUrl = `${config.APP_URL}/api/download/${fileId}`;

	// Build response payload
	const responsePayload = {
		success: true as const,
		fileId,
		filename: file.name,
		size: file.size,
		downloadUrl,
		uploadedAt: customMetadata.uploadedAt,
		expiration: customMetadata.expiration || null,
	};

	// Cache metadata in KV for faster lookups
	if (env.FILE_METADATA) {
		await env.FILE_METADATA.put(
			`file:${fileId}`,
			JSON.stringify({ ...customMetadata, r2Key: objectKey })
		);
	}

	logger.info('File uploaded successfully', { fileId, downloadUrl });

	return c.json(responsePayload, 201);
}
