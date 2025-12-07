/**
 * @fileoverview File listing handlers for public and admin views using D1.
 *
 * Provides endpoints for:
 * - Public file listings (filtered by visibility and expiration)
 * - Admin file listings (with statistics and all files)
 * - Expired file cleanup
 */

import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User, FileListItem } from '../types';
import { isAdmin } from '../auth';

// ============================================================================
// Validation Schemas
// ============================================================================

const listQuerySchema = z.object({
	search: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().optional(),
	sortBy: z.enum(['uploadedAt', 'size', 'filename']).default('uploadedAt'),
	sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const adminListQuerySchema = listQuerySchema.extend({
	includeExpired: z.preprocess((v) => String(v) !== 'false', z.boolean().default(true)),
	includeHidden: z.preprocess((v) => String(v) !== 'false', z.boolean().default(true)),
});

type ListFilterOptions = z.infer<typeof adminListQuerySchema>;

// ============================================================================
// Types
// ============================================================================

interface FileStats {
	totalFiles: number;
	totalSize: number;
	expiredFiles: number;
	hiddenFiles: number;
	publicFiles: number;
	averageSize: number;
	largestFileSize: number;
}

interface FilteredFilesResult {
	files: FileListItem[];
	nextCursor?: string;
}

// ============================================================================
// Public List Handler
// ============================================================================

export async function handleList(c: Context<{ Bindings: Env; Variables: { user?: User } }>): Promise<Response> {
	const { logger } = c.env;
	const user = c.get('user');
	const query = listQuerySchema.parse(c.req.query());

	logger.info('[LIST] Public file list requested', {
		...query,
		user: user?.email || 'anonymous',
		roles: user?.roles || ['public'],
	});

	const result = await getFilteredFilesFromD1(c, {
		...query,
		includeExpired: false,
		includeHidden: false,
	});

	logger.info('[LIST] Public list returning', {
		filesCount: result.files.length,
		hasNextCursor: !!result.nextCursor,
	});

	return c.json({
		success: true,
		files: result.files,
		nextCursor: result.nextCursor,
	});
}

// ============================================================================
// Admin List Handler
// ============================================================================

export async function handleAdminList(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { logger, DB } = c.env;
	const user = c.get('user');
	const query = adminListQuerySchema.parse(c.req.query());

	logger.info('[LIST] Admin file list requested', {
		...query,
		user: user.email,
	});

	const [stats, filteredResult] = await Promise.all([calculateStats(DB, logger), getFilteredFilesFromD1(c, query)]);

	logger.info('[LIST] Admin list returning', {
		totalFiles: stats.totalFiles,
		filteredCount: filteredResult.files.length,
		stats,
	});

	return c.json({
		success: true,
		files: filteredResult.files,
		stats,
		nextCursor: filteredResult.nextCursor,
	});
}

async function calculateStats(db: D1Database, logger: any): Promise<FileStats> {
	const now = new Date().toISOString();

	logger.debug('[STATS] Calculating file statistics');

	try {
		const results = await db
			.prepare(
				`SELECT
					COUNT(*) as totalFiles,
					COALESCE(SUM(size), 0) as totalSize,
					COUNT(CASE WHEN expiration IS NOT NULL AND expiration <= ?1 THEN 1 END) as expiredFiles,
					COUNT(CASE WHEN hideFromList = 1 THEN 1 END) as hiddenFiles,
					COUNT(CASE WHEN hideFromList = 0 THEN 1 END) as publicFiles
				FROM files`
			)
			.bind(now)
			.first<{
				totalFiles: number;
				totalSize: number;
				expiredFiles: number;
				hiddenFiles: number;
				publicFiles: number;
			}>();

		// Calculate average and largest separately (SQLite AVG/MAX on empty set returns NULL)
		const sizeStats = await db
			.prepare(
				`SELECT
					COALESCE(AVG(size), 0) as averageSize,
					COALESCE(MAX(size), 0) as largestFileSize
				FROM files
				WHERE size > 0`
			)
			.first<{
				averageSize: number;
				largestFileSize: number;
			}>();

		const stats = {
			totalFiles: results?.totalFiles ?? 0,
			totalSize: results?.totalSize ?? 0,
			expiredFiles: results?.expiredFiles ?? 0,
			hiddenFiles: results?.hiddenFiles ?? 0,
			publicFiles: results?.publicFiles ?? 0,
			averageSize: Math.round(sizeStats?.averageSize ?? 0),
			largestFileSize: sizeStats?.largestFileSize ?? 0,
		};

		logger.debug('[STATS] Statistics calculated', { stats });

		return stats;
	} catch (error) {
		logger.error('[STATS] Failed to calculate stats', {
			error: error instanceof Error ? error.message : 'Unknown error',
		});

		// Return empty stats on error
		return {
			totalFiles: 0,
			totalSize: 0,
			expiredFiles: 0,
			hiddenFiles: 0,
			publicFiles: 0,
			averageSize: 0,
			largestFileSize: 0,
		};
	}
}

// ============================================================================
// Shared File Filtering
// ============================================================================

async function getFilteredFilesFromD1(
	c: Context<{ Bindings: Env; Variables: { user?: User } }>,
	options: ListFilterOptions
): Promise<FilteredFilesResult> {
	const { DB, logger } = c.env;
	const caller = c.get('user');
	const { search, limit, cursor, sortBy, sortOrder, includeExpired, includeHidden } = options;
	const callerIsAdmin = isAdmin(caller);
	const callerRoles = caller?.roles ?? [];
	const now = new Date().toISOString();

	logger.debug('[FILTER] Building query', {
		callerEmail: caller?.email || 'anonymous',
		callerIsAdmin,
		callerRoles,
		includeExpired,
		includeHidden,
		search,
		limit,
	});

	let query = 'SELECT * FROM files';
	const whereClauses: string[] = [];
	const bindings: (string | number)[] = [];

	if (!includeExpired) {
		whereClauses.push('(expiration IS NULL OR expiration > ?)');
		bindings.push(now);
		logger.debug('[FILTER] Excluding expired files', { now });
	}

	if (!includeHidden) {
		whereClauses.push('hideFromList = 0');
		logger.debug('[FILTER] Excluding hidden files');
	}

	if (!callerIsAdmin) {
		if (callerRoles.length > 0) {
			whereClauses.push(`(requiredRole IS NULL OR requiredRole IN (${callerRoles.map(() => '?').join(',')}))`);
			bindings.push(...callerRoles);
			logger.debug('[FILTER] Role-based filtering', { callerRoles });
		} else {
			whereClauses.push('requiredRole IS NULL');
			logger.debug('[FILTER] Public access only (no roles)');
		}
	} else {
		logger.debug('[FILTER] Admin access - no role restrictions');
	}

	if (search) {
		whereClauses.push('(filename LIKE ? OR description LIKE ? OR tags LIKE ?)');
		const searchTerm = `%${search}%`;
		bindings.push(searchTerm, searchTerm, searchTerm);
		logger.debug('[FILTER] Search filter applied', { search });
	}

	if (whereClauses.length > 0) {
		query += ' WHERE ' + whereClauses.join(' AND ');
	}

	query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}, id ${sortOrder.toUpperCase()}`;

	if (cursor) {
		const offset = parseInt(cursor, 10);
		query += ` OFFSET ${offset}`;
		logger.debug('[FILTER] Cursor offset applied', { offset });
	}

	query += ` LIMIT ?`;
	bindings.push(limit);

	logger.debug('[FILTER] Executing D1 query', {
		query,
		bindingsCount: bindings.length,
		// Don't log actual bindings as they may be sensitive
	});

	try {
		const { results } = await DB.prepare(query)
			.bind(...bindings)
			.all<any>();

		logger.info('[FILTER] Query executed', {
			resultCount: results?.length ?? 0,
			limit,
		});

		if (!results || results.length === 0) {
			logger.warn('[FILTER] No files found matching criteria', {
				whereClauses,
				search,
				includeExpired,
				includeHidden,
			});

			// Debug: Check if ANY files exist in the database
			const totalCount = await DB.prepare('SELECT COUNT(*) as count FROM files').first<{ count: number }>();
			logger.debug('[FILTER] Total files in database', {
				totalCount: totalCount?.count ?? 0,
			});
		}

		const files: FileListItem[] = results.map((row: any) => {
			const isExpired = row.expiration ? new Date(row.expiration) <= new Date() : false;

			return {
				fileId: row.id,
				filename: row.filename,
				description: row.description,
				tags: row.tags,
				expiration: row.expiration,
				checksum: row.checksum,
				uploadedAt: row.uploadedAt,
				size: row.size,
				contentType: row.contentType,
				uploadType: row.uploadType,
				downloadUrl: `/api/download/${row.id}`,
				isExpired,
				hideFromList: Boolean(row.hideFromList),
				requiredRole: row.requiredRole,
			};
		});

		let nextCursor: string | undefined;
		if (files.length === limit) {
			const currentOffset = cursor ? parseInt(cursor, 10) : 0;
			nextCursor = (currentOffset + limit).toString();
			logger.debug('[FILTER] Next cursor generated', { nextCursor });
		}

		return { files, nextCursor };
	} catch (error) {
		logger.error(
			'[FILTER] D1 query failed',
			{
				error: error instanceof Error ? error.message : 'Unknown error',
				query,
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		throw new HTTPException(500, {
			message: 'Failed to retrieve file list',
			cause: error,
		});
	}
}

// ============================================================================
// Cleanup Handler
// ============================================================================

export async function cleanupExpiredFiles(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { DB, R2_FILES, logger } = c.env;
	const user = c.get('user');
	const now = new Date().toISOString();

	logger.info('[CLEANUP] Starting expired file cleanup', {
		initiatedBy: user.email,
		timestamp: now,
	});

	try {
		const { results } = await DB.prepare('SELECT id, r2Key FROM files WHERE expiration IS NOT NULL AND expiration <= ?')
			.bind(now)
			.all<{ id: string; r2Key: string }>();

		if (!results || results.length === 0) {
			logger.info('[CLEANUP] No expired files found');
			return c.json({ success: true, deletedCount: 0 });
		}

		logger.info('[CLEANUP] Found expired files', {
			count: results.length,
			fileIds: results.map((r) => r.id),
		});

		const expiredFileIds = results.map((r) => r.id);
		const expiredR2Keys = results.map((r) => r.r2Key);

		logger.debug('[CLEANUP] Deleting from D1 and R2', {
			fileCount: expiredFileIds.length,
		});

		// Delete from D1 and R2 in parallel
		const [d1Result] = await Promise.all([
			DB.prepare(`DELETE FROM files WHERE id IN (${expiredFileIds.map(() => '?').join(',')})`)
				.bind(...expiredFileIds)
				.run(),
			R2_FILES.delete(expiredR2Keys),
		]);

		logger.info('[CLEANUP] Cleanup completed', {
			deletedCount: expiredFileIds.length,
			d1Success: d1Result.success,
			d1Meta: d1Result.meta,
		});

		return c.json({
			success: true,
			deletedCount: expiredFileIds.length,
			message: `Deleted ${expiredFileIds.length} expired file(s).`,
		});
	} catch (error) {
		logger.error(
			'[CLEANUP] Cleanup failed',
			{
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			},
			error instanceof Error ? error : undefined
		);

		throw new HTTPException(500, {
			message: 'Failed to cleanup expired files',
			cause: error,
		});
	}
}
