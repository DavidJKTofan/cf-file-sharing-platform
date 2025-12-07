/**
 * @fileoverview File upload handler for direct multipart uploads.
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User, CfProperties } from '../types';

// ============================================================================
// Types
// ============================================================================

interface FileCustomMetadata {
	fileId: string;
	description: string;
	tags: string;
	expiration: string;
	checksum: string;
	originalName: string;
	uploadedAt: string;
	hideFromList: string;
	requiredRole: string;
	uploadType: string;
	asn: string;
	country: string;
	city: string;
	timezone: string;
	userAgent: string;
}

// ============================================================================
// Validation Schemas
// ============================================================================

const uploadFormSchema = z.object({
	file: z.instanceof(File, { message: 'A file is required' }),
	description: z.string().max(1000).optional(),
	tags: z.string().max(500).optional(),
	expiration: z.string().optional(),
	checksum: z.string().max(128).optional(),
	hideFromList: z
		.string()
		.transform((s) => s.toLowerCase() === 'true')
		.optional(),
	requiredRole: z.string().max(50).optional(),
});

type UploadFormData = z.infer<typeof uploadFormSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

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

function extractCfProperties(req: Request): CfProperties {
	const cf = (req as unknown as { cf?: CfProperties }).cf;
	return cf ?? {};
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Safely serializes R2 checksums object to string.
 * FIX: Properly handle R2Checksums object
 */
function serializeChecksums(checksums: R2Checksums | undefined): string {
	if (!checksums) {
		return '{}';
	}

	try {
		const checksumObj = checksums.toJSON();
		return JSON.stringify(checksumObj);
	} catch (error) {
		console.error('[UPLOAD] Failed to serialize checksums', { error });
		return '{}';
	}
}

// ============================================================================
// Upload Handler
// ============================================================================

export async function handleUpload(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { config, logger } = env;
	const user = c.get('user');

	logger.info('[UPLOAD] Direct upload requested', {
		uploader: user.email,
		sub: user.sub,
		roles: user.roles,
	});

	// Validate content type
	const contentType = req.header('content-type') ?? '';
	if (!contentType.includes('multipart/form-data')) {
		logger.error('[UPLOAD] Invalid content type', {
			contentType,
			expected: 'multipart/form-data',
		});
		throw new HTTPException(400, {
			message: 'Invalid content type. Expected multipart/form-data.',
		});
	}

	// Parse and validate form data
	logger.debug('[UPLOAD] Parsing form data');
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
		logger.error('[UPLOAD] Validation failed', {
			errors: validated.error.flatten(),
			formDataKeys: Array.from(formData.keys()),
		});
		throw new HTTPException(400, {
			message: 'Invalid form data',
			cause: validated.error,
		});
	}

	const { file, description, tags, expiration, checksum, hideFromList, requiredRole } = validated.data;

	logger.debug('[UPLOAD] Form data validated', {
		filename: file.name,
		size: file.size,
		type: file.type,
		description: description?.substring(0, 50),
		tags,
		hideFromList,
		requiredRole,
	});

	// Validate file size
	if (file.size > config.MAX_TOTAL_FILE_SIZE) {
		const maxSize = formatFileSize(config.MAX_TOTAL_FILE_SIZE);
		logger.warn('[UPLOAD] File too large', {
			fileSize: file.size,
			maxSize: config.MAX_TOTAL_FILE_SIZE,
			filename: file.name,
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

	logger.info('[UPLOAD] Starting upload', {
		fileId,
		filename: file.name,
		size: file.size,
		contentType: file.type,
		objectKey,
		uploader: user.email,
	});

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
		uploadType: 'direct',
		asn: String(cf.asn ?? ''),
		country: cf.country ?? '',
		city: cf.city ?? '',
		timezone: cf.timezone ?? '',
		userAgent: req.header('User-Agent') ?? '',
	};

	logger.debug('[UPLOAD] Custom metadata prepared', {
		fileId,
		metadata: customMetadata,
	});

	// Upload to R2
	let r2Object: R2Object;
	try {
		logger.debug('[UPLOAD] Uploading to R2', { objectKey });

		r2Object = await env.R2_FILES.put(objectKey, file.stream(), {
			httpMetadata: { contentType: file.type || 'application/octet-stream' },
			customMetadata: customMetadata as unknown as Record<string, string>,
		});

		logger.info('[UPLOAD] R2 upload successful', {
			fileId,
			key: r2Object.key,
			size: r2Object.size,
			etag: r2Object.etag,
			checksums: r2Object.checksums ? r2Object.checksums.toJSON() : null,
		});
	} catch (error) {
		logger.error(
			'[UPLOAD] R2 upload failed',
			{
				fileId,
				objectKey,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		throw new HTTPException(500, {
			message: 'Failed to upload file to storage',
			cause: error,
		});
	}

	// FIX: Properly serialize checksums
	const checksumString = serializeChecksums(r2Object.checksums);

	logger.debug('[UPLOAD] Serialized checksums', {
		fileId,
		checksum: checksumString,
	});

	// Write metadata to D1
	logger.debug('[UPLOAD] Writing metadata to D1', { fileId });

	try {
		const result = await env.DB.prepare(
			`INSERT INTO files (id, filename, description, tags, size, contentType, uploadedAt, expiration, checksum, uploadType, hideFromList, requiredRole, ownerId, r2Key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				fileId,
				file.name,
				description || null,
				tags || null,
				file.size,
				file.type || 'application/octet-stream',
				customMetadata.uploadedAt,
				expirationDate?.toISOString() || null,
				checksumString, // FIX: Use properly serialized checksum
				'direct',
				hideFromList ? 1 : 0,
				requiredRole || null,
				user.sub,
				objectKey
			)
			.run();

		logger.info('[UPLOAD] D1 metadata written', {
			fileId,
			success: result.success,
			meta: result.meta,
		});

		// Verify D1 write
		const verification = await env.DB.prepare('SELECT id, filename, size, checksum FROM files WHERE id = ?').bind(fileId).first();

		if (verification) {
			logger.info('[UPLOAD] D1 write verified', {
				fileId,
				verification,
			});
		} else {
			logger.error('[UPLOAD] D1 verification failed - record not found!', {
				fileId,
				criticalError: true,
			});

			// Roll back R2 upload
			await env.R2_FILES.delete(objectKey);
			logger.warn('[UPLOAD] Rolled back R2 object due to D1 verification failure', {
				fileId,
			});

			throw new HTTPException(500, {
				message: 'Failed to verify file metadata. Upload rolled back.',
			});
		}
	} catch (error) {
		logger.error(
			'[UPLOAD] D1 write failed',
			{
				fileId,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		// If D1 write fails, delete the R2 object to avoid orphaned files
		try {
			await env.R2_FILES.delete(objectKey);
			logger.warn('[UPLOAD] Rolled back R2 object due to D1 failure', { fileId });
		} catch (deleteError) {
			logger.error('[UPLOAD] Failed to rollback R2 object', {
				fileId,
				objectKey,
				error: deleteError instanceof Error ? deleteError.message : 'Unknown error',
			});
		}

		throw new HTTPException(500, {
			message: 'Failed to save file metadata. Please try again.',
			cause: error,
		});
	}

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

	logger.info('[UPLOAD] Upload completed successfully', {
		fileId,
		filename: file.name,
		size: file.size,
		downloadUrl,
	});

	return c.json(responsePayload, 201);
}
