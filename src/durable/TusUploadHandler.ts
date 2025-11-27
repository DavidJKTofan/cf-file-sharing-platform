/**
 * @fileoverview TUS Upload Handler Durable Object with SQLite storage.
 *
 * Implements the TUS resumable upload protocol using Cloudflare Durable Objects
 * with SQLite storage backend for persistent upload state management.
 *
 * Features:
 * - Resumable multipart uploads to R2
 * - Automatic cleanup via alarms
 * - SQLite-backed state persistence
 * - Concurrent upload protection
 *
 * @module durable/TusUploadHandler
 * @see {@link https://tus.io/protocols/resumable-upload}
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

/** Upload expiration time in milliseconds (7 days) */
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
}

/**
 * Upload metadata stored in SQLite.
 * Uses index signature to satisfy SqlStorage constraint.
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
	isCompleted: number; // SQLite stores as integer
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
 *
 * @remarks
 * Uses SQLite storage for persistent state management. Each upload gets
 * its own Durable Object instance, identified by a unique upload ID.
 *
 * The upload state includes:
 * - Upload metadata (size, filename, content type)
 * - List of uploaded parts with ETags
 * - Expiration timestamp for automatic cleanup
 *
 * @example
 * ```typescript
 * // Get stub for upload
 * const id = env.TUS_UPLOAD_HANDLER.idFromName(uploadId);
 * const stub = env.TUS_UPLOAD_HANDLER.get(id);
 *
 * // Create or resume upload
 * const result = await stub.createUpload({
 *   r2Key: 'files/my-file.pdf',
 *   totalSize: 1024 * 1024 * 100,
 *   filename: 'my-file.pdf',
 *   contentType: 'application/pdf',
 * });
 * ```
 */
export class TusUploadHandler extends DurableObject<TusUploadEnv> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: TusUploadEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		// Initialize SQLite tables
		this.initializeDatabase();
	}

	/**
	 * Initializes SQLite tables for upload state.
	 */
	private initializeDatabase(): void {
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
				is_completed INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS uploaded_parts (
				part_number INTEGER PRIMARY KEY,
				etag TEXT NOT NULL,
				size INTEGER NOT NULL
			);
		`);
	}

	/**
	 * Handles alarm for automatic cleanup of expired uploads.
	 */
	async alarm(): Promise<void> {
		const info = this.getUploadInfo();
		if (!info) {
			return;
		}

		// Abort multipart upload if not completed
		if (!info.isCompleted && info.multipartUploadId) {
			try {
				const multipart = this.env.R2_FILES.resumeMultipartUpload(
					info.r2Key,
					info.multipartUploadId
				);
				await multipart.abort();
			} catch {
				// Ignore errors - upload may already be aborted or completed
			}
		}

		// Clear all storage
		await this.ctx.storage.deleteAll();
	}

	/**
	 * Gets current upload info from SQLite.
	 */
	private getUploadInfo(): UploadInfo | null {
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
				is_completed as isCompleted
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
		};
	}

	/**
	 * Gets all uploaded parts from SQLite.
	 */
	private getUploadedParts(): UploadedPartRow[] {
		const cursor = this.sql.exec(`
			SELECT part_number as partNumber, etag, size
			FROM uploaded_parts
			ORDER BY part_number ASC
		`);

		return [...cursor] as unknown as UploadedPartRow[];
	}

	/**
	 * Creates a new upload or resumes an existing one.
	 *
	 * @param params - Upload parameters
	 * @returns Upload result with action taken
	 */
	async createUpload(params: {
		r2Key: string;
		totalSize: number;
		filename: string;
		contentType?: string;
		customMetadata?: Record<string, string>;
	}): Promise<CreateUploadResult> {
		const existingInfo = this.getUploadInfo();

		// If upload exists and matches, resume it
		if (existingInfo) {
			if (existingInfo.r2Key !== params.r2Key) {
				throw new Error('Conflict: Upload exists with different key');
			}

			// Check if expired
			if (Date.now() > existingInfo.expiresAt) {
				// Clean up and start fresh
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
		const multipartUpload = await this.env.R2_FILES.createMultipartUpload(params.r2Key, {
			httpMetadata: {
				contentType: params.contentType || 'application/octet-stream',
			},
			customMetadata: params.customMetadata,
		});

		const now = Date.now();
		const expiresAt = now + UPLOAD_EXPIRATION_MS;
		const uploadId = crypto.randomUUID();

		// Store upload info
		this.sql.exec(
			`
			INSERT OR REPLACE INTO upload_info (
				id, upload_id, r2_key, multipart_upload_id, total_size,
				uploaded_size, filename, content_type, custom_metadata,
				created_at, expires_at, is_completed
			) VALUES (1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0)
		`,
			uploadId,
			params.r2Key,
			multipartUpload.uploadId,
			params.totalSize,
			params.filename,
			params.contentType || 'application/octet-stream',
			JSON.stringify(params.customMetadata || {}),
			now,
			expiresAt
		);

		// Set alarm for cleanup
		await this.ctx.storage.setAlarm(expiresAt);

		return {
			action: 'created',
			uploadId,
			uploadedSize: 0,
			expiresAt,
		};
	}

	/**
	 * Gets current upload status.
	 *
	 * @returns Upload info or null if not found
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
	 *
	 * @param offset - Expected upload offset
	 * @param data - Chunk data as ArrayBuffer
	 * @returns Upload result with new offset
	 * @throws Error if offset mismatch or upload not found
	 */
	async uploadPart(offset: number, data: ArrayBuffer): Promise<UploadPartResult> {
		const info = this.getUploadInfo();
		if (!info) {
			throw new Error('Upload not found');
		}

		if (info.isCompleted) {
			return {
				uploadedSize: info.uploadedSize,
				isCompleted: true,
			};
		}

		// Validate offset
		if (offset !== info.uploadedSize) {
			throw new Error(`Offset mismatch: expected ${info.uploadedSize}, got ${offset}`);
		}

		// Calculate part number
		const parts = this.getUploadedParts();
		const partNumber = parts.length + 1;

		// Upload part to R2
		const multipart = this.env.R2_FILES.resumeMultipartUpload(
			info.r2Key,
			info.multipartUploadId
		);
		const uploadedPart = await multipart.uploadPart(partNumber, data);

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

		// Check if upload is complete
		if (newUploadedSize >= info.totalSize) {
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
	}

	/**
	 * Completes the multipart upload.
	 */
	private async completeUpload(): Promise<void> {
		const info = this.getUploadInfo();
		if (!info || info.isCompleted) {
			return;
		}

		const parts = this.getUploadedParts();
		if (parts.length === 0) {
			throw new Error('No parts uploaded');
		}

		// Complete multipart upload in R2
		const multipart = this.env.R2_FILES.resumeMultipartUpload(
			info.r2Key,
			info.multipartUploadId
		);

		const completedParts = parts.map((p) => ({
			partNumber: p.partNumber,
			etag: p.etag,
		}));

		await multipart.complete(completedParts);

		// Mark as completed
		this.sql.exec(`UPDATE upload_info SET is_completed = 1 WHERE id = 1`);

		// Cancel the cleanup alarm since upload is complete
		await this.ctx.storage.deleteAlarm();
	}

	/**
	 * Deletes/aborts the upload.
	 */
	async deleteUpload(): Promise<void> {
		const info = this.getUploadInfo();

		if (info && !info.isCompleted && info.multipartUploadId) {
			try {
				const multipart = this.env.R2_FILES.resumeMultipartUpload(
					info.r2Key,
					info.multipartUploadId
				);
				await multipart.abort();
			} catch {
				// Ignore errors - upload may already be aborted
			}
		}

		// Clear all storage
		await this.ctx.storage.deleteAll();
	}
}
