/**
 * @fileoverview TUS Upload Handler Durable Object with SQLite storage.
 *
 * Implements the TUS resumable upload protocol using Cloudflare Durable Objects
 * with SQLite storage backend for persistent upload state management.
 */

import { DurableObject } from 'cloudflare:workers';

// ============================================================================
// Constants
// ============================================================================

/** TUS protocol version */
export const TUS_VERSION = '1.0.0';

/** Maximum upload size (5GB) */
export const TUS_MAX_SIZE = 5 * 1024 * 1024 * 1024;

/** Minimum chunk size for multipart uploads (5MB - R2 minimum) */
const MIN_PART_SIZE = 5 * 1024 * 1024;

/**
 * Upload state expiration time in milliseconds (7 days).
 *
 * IMPORTANT: This is NOT the file expiration date!
 * This is how long the TUS upload session state is kept alive in the Durable Object.
 *
 * - If an upload is not completed within 7 days, the upload SESSION expires
 * - The actual FILE expiration is set by the admin during upload (optional)
 * - FILE expiration is stored in D1 metadata and checked on download
 *
 * Example:
 * - Admin uploads file with "expires in 1 hour"
 * - TUS upload session has 7 days to complete
 * - Once completed, file expires in 1 hour as specified
 */
const UPLOAD_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Supported TUS extensions */
export const TUS_EXTENSIONS = 'creation,creation-with-upload,expiration,termination';

// ============================================================================
// Types
// ============================================================================

/**
 * Environment bindings for the Durable Object.
 */
export interface TusUploadEnv {
	R2_FILES: R2Bucket;
	DB: D1Database;
}

/**
 * Upload metadata stored in SQLite.
 */
type UploadInfoRow = {
	uploadId: string;
	r2Key: string;
	multipartUploadId: string;
	totalSize: number;
	uploadedSize: number;
	filename: string;
	contentType: string;
	customMetadata: string;
	createdAt: number;
	expiresAt: number;
	isCompleted: number;
	ownerId?: string;
};

/**
 * Parsed upload info with proper types.
 */
interface UploadInfo {
	uploadId: string;
	r2Key: string;
	multipartUploadId: string;
	totalSize: number;
	uploadedSize: number;
	filename: string;
	contentType: string;
	customMetadata: string;
	createdAt: number;
	expiresAt: number;
	isCompleted: boolean;
	ownerId?: string;
}

/**
 * Uploaded part record from SQLite.
 */
type UploadedPartRow = {
	partNumber: number;
	etag: string;
	size: number;
};

/**
 * Result from createUpload method.
 */
export interface CreateUploadResult {
	action: 'created' | 'resumed';
	uploadId: string;
	uploadedSize: number;
	expiresAt: number;
}

/**
 * Result from uploadPart method.
 */
export interface UploadPartResult {
	uploadedSize: number;
	isCompleted: boolean;
}

// ============================================================================
// TUS Upload Handler Durable Object
// ============================================================================

/**
 * Durable Object for managing TUS resumable uploads.
 */
export class TusUploadHandler extends DurableObject<TusUploadEnv> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: TusUploadEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		console.log('[DO] TusUploadHandler initialized', {
			doId: ctx.id.toString(),
		});

		// Initialize SQLite tables
		this.initializeDatabase();
	}

	/**
	 * Initializes SQLite tables for upload state.
	 */
	private initializeDatabase(): void {
		try {
			this.sql.exec(`
				CREATE TABLE IF NOT EXISTS upload_info (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					upload_id TEXT NOT NULL,
					r2_key TEXT NOT NULL,
					multipart_upload_id TEXT NOT NULL,
					total_size INTEGER NOT NULL,
					uploaded_size INTEGER NOT NULL DEFAULT 0,
					filename TEXT NOT NULL,
					content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
					custom_metadata TEXT DEFAULT '{}',
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					is_completed INTEGER NOT NULL DEFAULT 0,
					owner_id TEXT
				);

				CREATE TABLE IF NOT EXISTS uploaded_parts (
					part_number INTEGER PRIMARY KEY,
					etag TEXT NOT NULL,
					size INTEGER NOT NULL
				);
			`);
			console.log('[DO] Database tables initialized');
		} catch (error) {
			console.error('[DO] Failed to initialize database', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			throw error;
		}
	}

	/**
	 * Handles alarm for automatic cleanup of expired uploads.
	 */
	async alarm(): Promise<void> {
		console.log('[DO] Alarm triggered for cleanup');

		const info = this.getUploadInfo();
		if (!info) {
			console.log('[DO] No upload info found, nothing to clean up');
			return;
		}

		console.log('[DO] Cleaning up upload', {
			uploadId: info.uploadId,
			isCompleted: info.isCompleted,
		});

		// Abort multipart upload if not completed
		if (!info.isCompleted && info.multipartUploadId) {
			try {
				const multipart = this.env.R2_FILES.resumeMultipartUpload(info.r2Key, info.multipartUploadId);
				await multipart.abort();
				console.log('[DO] Multipart upload aborted', { uploadId: info.uploadId });
			} catch (error) {
				console.warn('[DO] Failed to abort multipart (may already be done)', {
					uploadId: info.uploadId,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		}

		// Clear all storage
		await this.ctx.storage.deleteAll();
		console.log('[DO] Storage cleared');
	}

	/**
	 * Gets current upload info from SQLite.
	 */
	private getUploadInfo(): UploadInfo | null {
		try {
			const cursor = this.sql.exec(`
				SELECT 
					upload_id as uploadId,
					r2_key as r2Key,
					multipart_upload_id as multipartUploadId,
					total_size as totalSize,
					uploaded_size as uploadedSize,
					filename,
					content_type as contentType,
					custom_metadata as customMetadata,
					created_at as createdAt,
					expires_at as expiresAt,
					is_completed as isCompleted,
					owner_id as ownerId
				FROM upload_info
				WHERE id = 1
			`);

			const rows = [...cursor];
			if (rows.length === 0) {
				return null;
			}

			const row = rows[0] as unknown as UploadInfoRow;
			return {
				uploadId: row.uploadId,
				r2Key: row.r2Key,
				multipartUploadId: row.multipartUploadId,
				totalSize: row.totalSize,
				uploadedSize: row.uploadedSize,
				filename: row.filename,
				contentType: row.contentType,
				customMetadata: row.customMetadata,
				createdAt: row.createdAt,
				expiresAt: row.expiresAt,
				isCompleted: Boolean(row.isCompleted),
				ownerId: row.ownerId,
			};
		} catch (error) {
			console.error('[DO] Failed to get upload info', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			return null;
		}
	}

	/**
	 * Gets all uploaded parts from SQLite.
	 */
	private getUploadedParts(): UploadedPartRow[] {
		try {
			const cursor = this.sql.exec(`
				SELECT part_number as partNumber, etag, size
				FROM uploaded_parts
				ORDER BY part_number ASC
			`);

			return [...cursor] as unknown as UploadedPartRow[];
		} catch (error) {
			console.error('[DO] Failed to get uploaded parts', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			return [];
		}
	}

	/**
	 * Creates a new upload or resumes an existing one.
	 */
	async createUpload(params: {
		r2Key: string;
		totalSize: number;
		filename: string;
		contentType?: string;
		customMetadata?: Record<string, string>;
		ownerId?: string;
	}): Promise<CreateUploadResult> {
		console.log('[DO] createUpload called', {
			r2Key: params.r2Key,
			totalSize: params.totalSize,
			filename: params.filename,
			ownerId: params.ownerId,
		});

		const existingInfo = this.getUploadInfo();

		// If upload exists and matches, resume it
		if (existingInfo) {
			console.log('[DO] Found existing upload', {
				uploadId: existingInfo.uploadId,
				uploadedSize: existingInfo.uploadedSize,
				expiresAt: existingInfo.expiresAt,
			});

			if (existingInfo.r2Key !== params.r2Key) {
				console.error('[DO] R2 key mismatch', {
					existing: existingInfo.r2Key,
					requested: params.r2Key,
				});
				throw new Error('Conflict: Upload exists with different key');
			}

			// Check if expired
			if (Date.now() > existingInfo.expiresAt) {
				console.log('[DO] Upload expired, cleaning up and starting fresh');
				await this.deleteUpload();
			} else {
				return {
					action: 'resumed',
					uploadId: existingInfo.uploadId,
					uploadedSize: existingInfo.uploadedSize,
					expiresAt: existingInfo.expiresAt,
				};
			}
		}

		// Create new multipart upload in R2
		console.log('[DO] Creating new R2 multipart upload', {
			r2Key: params.r2Key,
			contentType: params.contentType,
		});

		try {
			const multipartUpload = await this.env.R2_FILES.createMultipartUpload(params.r2Key, {
				httpMetadata: {
					contentType: params.contentType || 'application/octet-stream',
				},
				customMetadata: params.customMetadata,
			});

			console.log('[DO] R2 multipart upload created', {
				uploadId: multipartUpload.uploadId,
				key: multipartUpload.key,
			});

			const now = Date.now();
			const expiresAt = now + UPLOAD_EXPIRATION_MS;
			const uploadId = crypto.randomUUID();

			// Store upload info
			this.sql.exec(
				`INSERT OR REPLACE INTO upload_info (
					id, upload_id, r2_key, multipart_upload_id, total_size,
					uploaded_size, filename, content_type, custom_metadata,
					created_at, expires_at, is_completed, owner_id
				) VALUES (1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?)`,
				uploadId,
				params.r2Key,
				multipartUpload.uploadId,
				params.totalSize,
				params.filename,
				params.contentType || 'application/octet-stream',
				JSON.stringify(params.customMetadata || {}),
				now,
				expiresAt,
				params.ownerId || null
			);

			console.log('[DO] Upload info stored in SQLite', {
				uploadId,
				ownerId: params.ownerId,
			});

			// Set alarm for cleanup
			await this.ctx.storage.setAlarm(expiresAt);
			console.log('[DO] Cleanup alarm set', { expiresAt: new Date(expiresAt).toISOString() });

			return {
				action: 'created',
				uploadId,
				uploadedSize: 0,
				expiresAt,
			};
		} catch (error) {
			console.error('[DO] Failed to create upload', {
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	/**
	 * Gets current upload status.
	 */
	async getUploadStatus(): Promise<{
		uploadId: string;
		uploadedSize: number;
		totalSize: number;
		expiresAt: number;
		isCompleted: boolean;
	} | null> {
		const info = this.getUploadInfo();
		if (!info) {
			return null;
		}

		return {
			uploadId: info.uploadId,
			uploadedSize: info.uploadedSize,
			totalSize: info.totalSize,
			expiresAt: info.expiresAt,
			isCompleted: info.isCompleted,
		};
	}

	/**
	 * Uploads a chunk of data.
	 */
	async uploadPart(offset: number, data: ArrayBuffer): Promise<UploadPartResult> {
		console.log('[DO] uploadPart called', {
			offset,
			dataSize: data.byteLength,
		});

		const info = this.getUploadInfo();
		if (!info) {
			console.error('[DO] Upload not found');
			throw new Error('Upload not found');
		}

		if (info.isCompleted) {
			console.log('[DO] Upload already completed');
			return {
				uploadedSize: info.uploadedSize,
				isCompleted: true,
			};
		}

		// Validate offset
		if (offset !== info.uploadedSize) {
			console.error('[DO] Offset mismatch', {
				expected: info.uploadedSize,
				received: offset,
			});
			throw new Error(`Offset mismatch: expected ${info.uploadedSize}, got ${offset}`);
		}

		// Calculate part number
		const parts = this.getUploadedParts();
		const partNumber = parts.length + 1;

		console.log('[DO] Uploading part to R2', {
			partNumber,
			size: data.byteLength,
			uploadId: info.uploadId,
		});

		try {
			// Upload part to R2
			const multipart = this.env.R2_FILES.resumeMultipartUpload(info.r2Key, info.multipartUploadId);
			const uploadedPart = await multipart.uploadPart(partNumber, data);

			console.log('[DO] Part uploaded to R2', {
				partNumber,
				etag: uploadedPart.etag,
			});

			// Store part info
			this.sql.exec(
				`INSERT INTO uploaded_parts (part_number, etag, size) VALUES (?, ?, ?)`,
				partNumber,
				uploadedPart.etag,
				data.byteLength
			);

			// Update uploaded size
			const newUploadedSize = info.uploadedSize + data.byteLength;
			this.sql.exec(`UPDATE upload_info SET uploaded_size = ? WHERE id = 1`, newUploadedSize);

			console.log('[DO] Upload progress updated', {
				newUploadedSize,
				totalSize: info.totalSize,
				progress: `${((newUploadedSize / info.totalSize) * 100).toFixed(2)}%`,
			});

			// Check if upload is complete
			if (newUploadedSize >= info.totalSize) {
				console.log('[DO] Upload complete, finalizing...');
				await this.completeUpload();
				return {
					uploadedSize: newUploadedSize,
					isCompleted: true,
				};
			}

			return {
				uploadedSize: newUploadedSize,
				isCompleted: false,
			};
		} catch (error) {
			console.error('[DO] Failed to upload part', {
				partNumber,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	/**
	 * Completes the multipart upload.
	 */
	private async completeUpload(): Promise<void> {
		const info = this.getUploadInfo();
		if (!info || info.isCompleted) {
			console.log('[DO] Upload already completed or not found');
			return;
		}

		const parts = this.getUploadedParts();
		if (parts.length === 0) {
			console.error('[DO] No parts uploaded');
			throw new Error('No parts uploaded');
		}

		console.log('[DO] Completing multipart upload', {
			uploadId: info.uploadId,
			partsCount: parts.length,
			totalSize: parts.reduce((sum, p) => sum + p.size, 0),
		});

		try {
			// Complete multipart upload in R2
			const multipart = this.env.R2_FILES.resumeMultipartUpload(info.r2Key, info.multipartUploadId);

			const completedParts = parts.map((p) => ({
				partNumber: p.partNumber,
				etag: p.etag,
			}));

			const r2Object = await multipart.complete(completedParts);

			console.log('[DO] R2 multipart upload completed', {
				key: r2Object.key,
				size: r2Object.size,
				checksums: r2Object.checksums.toJSON(),
			});

			// Mark as completed in DO
			this.sql.exec(`UPDATE upload_info SET is_completed = 1 WHERE id = 1`);
			console.log('[DO] Upload marked as completed in SQLite');

			// Write metadata to D1 (with detailed logging)
			console.log('[DO] Starting D1 metadata write');
			await this.writeMetadataToD1(info, r2Object);

			// Cancel the cleanup alarm since upload is complete
			await this.ctx.storage.deleteAlarm();
			console.log('[DO] Cleanup alarm cancelled');
		} catch (error) {
			console.error('[DO] Failed to complete upload', {
				uploadId: info.uploadId,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	/**
	 * Writes the completed upload's metadata to the D1 `files` table.
	 */
	private async writeMetadataToD1(info: UploadInfo, r2Object: R2Object): Promise<void> {
		try {
			const customMetadata = JSON.parse(info.customMetadata || '{}');
			const fileId = info.uploadId;

			// FIX: Properly serialize checksums
			let checksumString = '{}';
			try {
				if (r2Object.checksums) {
					checksumString = JSON.stringify(r2Object.checksums.toJSON());
				}
			} catch (csError) {
				console.warn('[DO] Failed to serialize checksums, using empty object', {
					error: csError instanceof Error ? csError.message : 'Unknown error',
				});
			}

			console.log('[DO] Writing to D1', {
				fileId,
				filename: info.filename,
				size: info.totalSize,
				ownerId: info.ownerId,
				customMetadata,
				checksum: checksumString,
			});

			const result = await this.env.DB.prepare(
				`INSERT INTO files (id, filename, description, tags, size, contentType, uploadedAt, expiration, checksum, uploadType, hideFromList, requiredRole, ownerId, r2Key)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
				.bind(
					fileId,
					info.filename,
					customMetadata.description || null,
					customMetadata.tags || null,
					info.totalSize,
					info.contentType,
					new Date(info.createdAt).toISOString(),
					customMetadata.expiration || null,
					checksumString, // FIX: Use properly serialized checksum
					'tus',
					customMetadata.hideFromList === 'true' ? 1 : 0,
					customMetadata.requiredRole || null,
					info.ownerId || null,
					info.r2Key
				)
				.run();

			console.log('[DO] D1 write successful', {
				fileId,
				success: result.success,
				meta: result.meta,
			});

			// Verify the write
			const verification = await this.env.DB.prepare('SELECT id, filename, size, checksum FROM files WHERE id = ?').bind(fileId).first();

			if (verification) {
				console.log('[DO] D1 write verified', { verification });
			} else {
				console.error('[DO] D1 verification failed - record not found!', { fileId });
			}
		} catch (error) {
			console.error('[DO] Failed to write metadata to D1', {
				uploadId: info.uploadId,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	/**
	 * Deletes/aborts the upload.
	 */
	async deleteUpload(): Promise<void> {
		console.log('[DO] deleteUpload called');

		const info = this.getUploadInfo();

		if (info && !info.isCompleted && info.multipartUploadId) {
			console.log('[DO] Aborting multipart upload', {
				uploadId: info.uploadId,
				r2Key: info.r2Key,
			});

			try {
				const multipart = this.env.R2_FILES.resumeMultipartUpload(info.r2Key, info.multipartUploadId);
				await multipart.abort();
				console.log('[DO] Multipart upload aborted');
			} catch (error) {
				console.warn('[DO] Failed to abort multipart (may already be done)', {
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		}

		// Clear all storage
		await this.ctx.storage.deleteAll();
		console.log('[DO] Storage cleared');
	}
}
