/**
 * @fileoverview File listing handlers for public and admin views.
 *
 * Provides endpoints for:
 * - Public file listings (filtered by visibility and expiration)
 * - Admin file listings (with statistics and all files)
 * - Expired file cleanup
 *
 * @module api/list
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User, FileListItem } from '../types';
import { isAdmin } from '../auth';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Schema for public list query parameters.
 */
const listQuerySchema = z.object({
	/** Search term for filtering by filename, description, or tags */
	search: z.string().max(200).optional(),
	/** Maximum number of files to return (1-100) */
	limit: z.coerce.number().int().min(1).max(100).default(100),
	/** Pagination cursor for fetching next page */
	cursor: z.string().optional(),
});

/**
 * Schema for admin list query parameters.
 * Extends public schema with additional filter options.
 */
const adminListQuerySchema = listQuerySchema.extend({
	/** Include expired files in results (default: true) */
	includeExpired: z.preprocess(
		(v) => String(v) !== 'false',
		z.boolean().default(true)
	),
	/** Include hidden files in results (default: true) */
	includeHidden: z.preprocess(
		(v) => String(v) !== 'false',
		z.boolean().default(true)
	),
});

/** Inferred type for filter options */
type ListFilterOptions = z.infer<typeof adminListQuerySchema>;

// ============================================================================
// Types
// ============================================================================

/** Statistics for admin file listing */
interface FileStats {
	totalFiles: number;
	totalSize: number;
	averageSize: number;
	largestFileSize: number;
	expiredFiles: number;
	hiddenFiles: number;
	publicFiles: number;
}

/** Result from getFilteredFiles */
interface FilteredFilesResult {
	files: FileListItem[];
}

// ============================================================================
// Public List Handler
// ============================================================================

/**
 * Handles public file listing requests.
 *
 * @remarks
 * Returns only publicly visible files:
 * - Excludes hidden files
 * - Excludes expired files
 * - Excludes files requiring roles the user doesn't have
 *
 * @param c - Hono context with environment bindings and optional user
 * @returns JSON response with file list
 */
export async function handleList(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>
): Promise<Response> {
	const { logger } = c.env;
	const query = listQuerySchema.parse(c.req.query());

	logger.debug('Public file list requested', { search: query.search, limit: query.limit });

	const result = await getFilteredFiles(c, {
		...query,
		includeExpired: false,
		includeHidden: false,
	});

	return c.json({
		success: true,
		files: result.files,
	});
}

// ============================================================================
// Admin List Handler
// ============================================================================

/**
 * Handles admin file listing requests with statistics.
 *
 * @remarks
 * Returns all files with comprehensive statistics:
 * - Total file count and size
 * - Expired and hidden file counts
 * - Supports filtering via query parameters
 *
 * @param c - Hono context with environment bindings and authenticated user
 * @returns JSON response with file list and statistics
 */
export async function handleAdminList(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { logger } = c.env;
	const query = adminListQuerySchema.parse(c.req.query());

	logger.debug('Admin file list requested', {
		search: query.search,
		includeExpired: query.includeExpired,
		includeHidden: query.includeHidden,
	});

	// Get all files to calculate comprehensive stats
	const allFilesResult = await getFilteredFiles(
		c as Context<{ Bindings: Env; Variables: { user?: User } }>,
		{
			limit: 1000,
			includeExpired: true,
			includeHidden: true,
		}
	);

	const allFiles = allFilesResult.files;
	const stats = calculateStats(allFiles);

	// Get filtered files for display based on query params
	const filteredResult = await getFilteredFiles(
		c as Context<{ Bindings: Env; Variables: { user?: User } }>,
		query
	);

	logger.info('Admin file list returned', {
		totalFiles: stats.totalFiles,
		filteredCount: filteredResult.files.length,
	});

	return c.json({
		success: true,
		files: filteredResult.files,
		stats,
	});
}

/**
 * Calculates statistics from a list of files.
 *
 * @param files - Array of file list items
 * @returns Computed statistics
 */
function calculateStats(files: FileListItem[]): FileStats {
	const totalSize = files.reduce((sum, file) => sum + file.size, 0);
	const expiredCount = files.filter((f) => f.isExpired).length;
	const hiddenCount = files.filter((f) => f.hideFromList).length;

	return {
		totalFiles: files.length,
		totalSize,
		averageSize: files.length > 0 ? Math.round(totalSize / files.length) : 0,
		largestFileSize: files.length > 0 ? Math.max(...files.map((f) => f.size)) : 0,
		expiredFiles: expiredCount,
		hiddenFiles: hiddenCount,
		publicFiles: files.length - hiddenCount,
	};
}

// ============================================================================
// Shared File Filtering
// ============================================================================

/**
 * Fetches and filters files from R2 based on options.
 *
 * @remarks
 * Applies multiple filters:
 * - Hidden file visibility
 * - Expiration status
 * - Role-based access
 * - Search term matching
 *
 * @param c - Hono context
 * @param options - Filter options
 * @returns Filtered and sorted file list
 */
async function getFilteredFiles(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>,
	options: ListFilterOptions
): Promise<FilteredFilesResult> {
	const { env } = c;
	const { logger } = env;
	const caller = c.get('user');
	const { search, limit, cursor, includeExpired, includeHidden } = options;

	logger.debug('Fetching files from R2', { limit, cursor: !!cursor });

	// Build R2 list options
	const listOptions: R2ListOptions = {
		limit: Math.min(limit, 1000),
		cursor,
		include: ['customMetadata'],
	};

	const listResult = await env.R2_FILES.list(listOptions);
	const files: FileListItem[] = [];
	const now = new Date();
	const callerRoles = caller?.roles ?? [];
	const callerIsAdmin = isAdmin(caller);

	// Process each R2 object
	for (const object of listResult.objects) {
		const fileItem = await processR2Object(env, object, {
			now,
			callerRoles,
			callerIsAdmin,
			includeExpired,
			includeHidden,
			search,
		});

		if (fileItem) {
			files.push(fileItem);
		}
	}

	// Sort by upload date (newest first)
	files.sort((a, b) => {
		const dateA = new Date(a.uploadedAt).getTime();
		const dateB = new Date(b.uploadedAt).getTime();
		return dateB - dateA;
	});

	return { files };
}

/** Options for processing individual R2 objects */
interface ProcessObjectOptions {
	now: Date;
	callerRoles: string[];
	callerIsAdmin: boolean;
	includeExpired: boolean;
	includeHidden: boolean;
	search?: string;
}

/**
 * Processes a single R2 object into a FileListItem.
 *
 * @param env - Environment bindings
 * @param object - R2 object from list
 * @param options - Processing options
 * @returns FileListItem or null if filtered out
 */
async function processR2Object(
	env: Env,
	object: R2Object,
	options: ProcessObjectOptions
): Promise<FileListItem | null> {
	const { now, callerRoles, callerIsAdmin, includeExpired, includeHidden, search } = options;

	// Parse object key
	const keyParts = object.key.split('/');
	const fileId = keyParts[0];
	const filename = keyParts.slice(1).join('/') || 'Unknown';

	// Fetch KV metadata if available
	let kvMetadata: Record<string, unknown> = {};
	if (env.FILE_METADATA) {
		try {
			const kvData = await env.FILE_METADATA.get(`file:${fileId}`);
			if (kvData) {
				kvMetadata = JSON.parse(kvData);
			}
		} catch {
			// Ignore KV parse errors
		}
	}

	// Merge metadata from R2 and KV
	const metadata = { ...object.customMetadata, ...kvMetadata };

	// Check hidden status
	const isHidden = metadata.hideFromList === 'true' || metadata.hideFromList === true;
	if (isHidden && !includeHidden) {
		return null;
	}

	// Check role requirement
	const requiredRole = (metadata.requiredRole ?? metadata.requiredrole) as string | undefined;
	if (requiredRole && !callerIsAdmin && !callerRoles.includes(requiredRole)) {
		return null;
	}

	// Check expiration
	const expirationString = (metadata.expiration as string) ?? '';
	let isExpired = false;
	if (expirationString) {
		const expirationDate = new Date(expirationString);
		isExpired = expirationDate <= now;
	}
	if (isExpired && !includeExpired) {
		return null;
	}

	// Apply search filter
	if (search) {
		const searchLower = search.toLowerCase();
		const searchableText = [
			filename,
			metadata.description as string,
			metadata.tags as string,
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase();

		if (!searchableText.includes(searchLower)) {
			return null;
		}
	}

	// Build file list item
	return {
		fileId,
		filename,
		description: (metadata.description as string) ?? '',
		tags: (metadata.tags as string) ?? '',
		expiration: expirationString,
		checksum: (metadata.checksum as string) ?? '',
		uploadedAt:
			(metadata.uploadedAt as string) ?? object.uploaded?.toISOString() ?? '',
		size: object.size,
		contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
		uploadType: (metadata.uploadType as string) ?? 'unknown',
		downloadUrl: `/api/download/${fileId}`,
		isExpired,
		hideFromList: isHidden,
		requiredRole: requiredRole ?? null,
	};
}

// ============================================================================
// Cleanup Handler
// ============================================================================

/**
 * Cleans up expired files from R2 and KV.
 *
 * @remarks
 * Iterates through all files in R2, identifies expired ones based on
 * their expiration metadata, and deletes them. Also removes corresponding
 * KV metadata entries.
 *
 * @param c - Hono context with environment bindings and authenticated user
 * @returns JSON response with count of deleted files
 */
export async function cleanupExpiredFiles(
	c: Context<{ Bindings: Env; Variables: { user: User } }>
): Promise<Response> {
	const { env } = c;
	const { logger } = env;

	if (!env.R2_FILES) {
		throw new HTTPException(500, { message: 'File storage is not configured.' });
	}

	logger.info('Starting expired file cleanup');

	let deletedCount = 0;
	let cursor: string | undefined;
	const now = new Date();

	// Iterate through all files in batches
	do {
		const listResult: R2Objects = await env.R2_FILES.list({
			limit: 500,
			cursor,
			include: ['customMetadata'],
		});

		// Find expired files
		const expiredKeys = listResult.objects
			.filter((obj) => {
				const expiration = obj.customMetadata?.expiration;
				return expiration && new Date(expiration) <= now;
			})
			.map((obj) => obj.key);

		// Delete expired files
		if (expiredKeys.length > 0) {
			logger.debug('Deleting expired files', { count: expiredKeys.length });

			await env.R2_FILES.delete(expiredKeys);
			deletedCount += expiredKeys.length;

			// Clean up KV metadata
			if (env.FILE_METADATA) {
				const deletePromises = expiredKeys.map((key) => {
					const fileId = key.split('/')[0];
					return env.FILE_METADATA!.delete(`file:${fileId}`);
				});
				await Promise.all(deletePromises);
			}
		}

		cursor = listResult.truncated ? listResult.cursor : undefined;
	} while (cursor);

	logger.info('Expired file cleanup completed', { deletedCount });

	return c.json({
		success: true,
		deletedCount,
		message: `Deleted ${deletedCount} expired file(s).`,
	});
}
