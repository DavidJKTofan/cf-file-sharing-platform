// src/api/list.ts
import { AwsClient } from 'aws4fetch';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { Env, User } from '../types';

interface FileListItem {
	fileId: string;
	filename: string;
	description?: string;
	tags?: string;
	expiration?: string;
	checksum?: string;
	uploadedAt: string;
	size: number;
	contentType?: string;
	uploadType?: string;
	downloadUrl: string;
	isExpired: boolean;
	hideFromList: boolean;
	requiredRole: string | null;
}

// Public list handler - excludes hidden and expired files by default
export async function handleList(c: Context<{ Bindings: Env; Variables: { user?: User } }>): Promise<Response> {
	const { env, req } = c;
	const caller = c.get('user');

	if (!env.R2_FILES) {
		throw new HTTPException(500, { message: 'File storage is not configured.' });
	}

	const url = new URL(req.url);
	const searchQuery = url.searchParams.get('search') || '';
	const limit = parseInt(url.searchParams.get('limit') || '100', 10);
	const cursor = url.searchParams.get('cursor') || undefined;

	const result = await getFilteredFiles(c as any, {
		searchQuery,
		limit: Math.min(limit, 100),
		cursor,
		includeExpired: false,
		includeHidden: false,
	});

	return c.json({
		success: true,
		files: result.files,
	});
}

// Admin list handler - includes all files with comprehensive stats
export async function handleAdminList(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { env, req } = c;

	if (!env.R2_FILES) {
		throw new HTTPException(500, { message: 'File storage is not configured.' });
	}

	const url = new URL(req.url);
	const searchQuery = url.searchParams.get('search') || '';
	const limit = parseInt(url.searchParams.get('limit') || '100', 10);
	const cursor = url.searchParams.get('cursor') || undefined;
	const includeExpired = url.searchParams.get('includeExpired') !== 'false';
	const includeHidden = url.searchParams.get('includeHidden') !== 'false';

	// Get all files to calculate comprehensive stats
	const allFilesResult = await getFilteredFiles(c, {
		searchQuery: '',
		limit: 1000,
		includeExpired: true,
		includeHidden: true,
	});

	const allFiles = allFilesResult.files || [];
	const totalSize = allFiles.reduce((sum, file) => sum + file.size, 0);
	const expiredCount = allFiles.filter((f) => f.isExpired).length;
	const hiddenCount = allFiles.filter((f) => f.hideFromList).length;

	const stats = {
		totalFiles: allFiles.length,
		totalSize,
		averageSize: allFiles.length > 0 ? totalSize / allFiles.length : 0,
		largestFileSize: Math.max(0, ...allFiles.map((f) => f.size)),
		expiredFiles: expiredCount,
		hiddenFiles: hiddenCount,
		publicFiles: allFiles.length - hiddenCount,
	};

	// Get filtered files for display
	const filteredResult = await getFilteredFiles(c, {
		searchQuery,
		limit: Math.min(limit, 100),
		cursor,
		includeExpired,
		includeHidden,
	});

	return c.json({
		success: true,
		files: filteredResult.files,
		stats,
	});
}

// Shared function to get filtered files
async function getFilteredFiles(
	c: Context<{ Bindings: Env; Variables: { user: User } }>,
	options: {
		searchQuery: string;
		limit: number;
		cursor?: string;
		includeExpired: boolean;
		includeHidden: boolean;
	},
): Promise<{ files: FileListItem[] }> {
	const { env } = c;
	const caller = c.get('user');
	const { searchQuery, limit, cursor, includeExpired, includeHidden } = options;

	if (env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] getFilteredFiles called with options:', JSON.stringify(options, null, 2));
		console.log('[DEBUG] Caller:', JSON.stringify(caller, null, 2));
	}

	const listOptions: R2ListOptions = {
		limit: Math.min(limit, 1000),
		cursor,
		include: ['customMetadata'],
	};

	const listResult = await env.R2_FILES.list(listOptions);
	const files: FileListItem[] = [];
	const now = new Date();
	const callerRoles = caller?.roles || [];
	const isCallerAdmin = callerRoles.includes('admin');

	for (const object of listResult.objects) {
		if (env.ENVIRONMENT === 'development') {
			console.log(`[DEBUG] Processing object: ${object.key}`, JSON.stringify(object.customMetadata, null, 2));
		}
		const keyParts = object.key.split('/');
		const fileId = keyParts[0];
		const filename = keyParts.slice(1).join('/');

		let kvMetadata: any = {};
		if (env.FILE_METADATA) {
			const kvData = await env.FILE_METADATA.get(`file:${fileId}`);
			if (kvData) kvMetadata = JSON.parse(kvData);
		}

		const customMetadata = { ...object.customMetadata, ...kvMetadata };
		const isHidden = customMetadata.hideFromList === 'true' || customMetadata.hideFromList === true;

		if (isHidden && !includeHidden && !isCallerAdmin) continue;

		const requiredRole = customMetadata.requiredRole || customMetadata.requiredrole;
		if (requiredRole && !isCallerAdmin && !callerRoles.includes(requiredRole)) {
			continue;
		}

		const expirationString = customMetadata.expiration || '';
		let isExpired = false;
		if (expirationString) {
			const expirationDate = new Date(expirationString);
			if (expirationDate <= now) isExpired = true;
		}

		if (isExpired && !includeExpired && !isCallerAdmin) continue;

		const searchableText = `${filename} ${customMetadata.description || ''} ${customMetadata.tags || ''}`.toLowerCase();
		if (searchQuery && !searchableText.includes(searchQuery.toLowerCase())) {
			continue;
		}

		files.push({
			fileId,
			filename: filename || 'Unknown',
			description: customMetadata.description || '',
			tags: customMetadata.tags || '',
			expiration: expirationString,
			checksum: customMetadata.checksum || '',
			uploadedAt: customMetadata.uploadedAt || object.uploaded?.toISOString() || '',
			size: object.size,
			contentType: object.httpMetadata?.contentType || 'application/octet-stream',
			uploadType: customMetadata.uploadType || 'unknown',
			downloadUrl: `/api/download/${fileId}`,
			isExpired,
			hideFromList: isHidden,
			requiredRole: requiredRole || null,
		});
	}

	files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
	return { files };
}

// Helper function to clean up expired files
export async function cleanupExpiredFiles(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { env } = c;
	if (!env.R2_FILES) {
		throw new HTTPException(500, { message: 'File storage is not configured.' });
	}

	if (env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] Starting cleanup of expired files.');
	}

	let deletedCount = 0;
	let cursor: string | undefined;
	const now = new Date();

	do {
		const listResult: R2Objects = await env.R2_FILES.list({ limit: 500, cursor, include: ['customMetadata'] });

		const expiredKeys = listResult.objects
			.filter((obj) => {
				const expiration = obj.customMetadata?.expiration;
				return expiration && new Date(expiration) <= now;
			})
			.map((obj) => obj.key);

		if (expiredKeys.length > 0) {
			if (env.ENVIRONMENT === 'development') {
				console.log(`[DEBUG] Deleting ${expiredKeys.length} expired files:`, expiredKeys);
			}
			await env.R2_FILES.delete(expiredKeys);
			deletedCount += expiredKeys.length;

			if (env.FILE_METADATA) {
				const expiredFileIds = expiredKeys.map((key) => key.split('/')[0]);
				for (const fileId of expiredFileIds) {
					await env.FILE_METADATA.delete(`file:${fileId}`);
				}
			}
		}
		cursor = listResult.truncated ? listResult.cursor : undefined;
	} while (cursor);

	if (env.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] Finished cleanup. Deleted ${deletedCount} files.`);
	}

	return c.json({ success: true, deletedCount });
}
