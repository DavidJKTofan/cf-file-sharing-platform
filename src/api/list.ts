// src/api/list.ts
import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

interface FileListItem {
	fileId: string;
	filename: string;
	description?: string;
	tags?: string;
	expiration?: string;
	checksum?: string;
	uploadedAt?: string;
	size: number;
	contentType?: string;
	uploadType?: string;
	downloadUrl: string;
	signedDownloadUrl?: string;
	lastModified?: string;
	etag?: string;
	isExpired?: boolean;
	hoursUntilExpiration?: number;
	hideFromList?: boolean;
	requiredRole?: string | null;
}

interface ListResponse {
	success: boolean;
	files?: FileListItem[];
	totalFiles?: number;
	expiredFiles?: number;
	hiddenFiles?: number;
	publicFiles?: number;
	error?: string;
}

interface AdminListResponse {
	success: boolean;
	files?: FileListItem[];
	stats?: {
		totalFiles: number;
		totalSize: number;
		averageSize: number;
		largestFileSize: number;
		expiredFiles: number;
		hiddenFiles: number;
		publicFiles: number;
	};
	error?: string;
}

/**
 * handleList now accepts an optional caller object (user) so it can enforce
 * `requiredRole` visibility per file. If caller has 'admin' in roles, they
 * see everything. If caller has the required role they see the file. If the
 * file has no requiredRole it is visible to everyone (including 'public').
 */

// Public list handler - excludes hidden and expired files by default
export async function handleList(request: Request, env: Env, caller?: any): Promise<ListResponse> {
	console.log('handleList called (public)');

	try {
		// Check if R2 bucket is available
		if (!env.R2_FILES) {
			console.error('R2_FILES bucket not available');
			return { success: false, error: 'Storage not configured' };
		}

		// Parse query parameters for filtering and pagination
		const url = new URL(request.url);
		const searchQuery = url.searchParams.get('search') || '';
		const limit = parseInt(url.searchParams.get('limit') || '100', 10);
		const cursor = url.searchParams.get('cursor') || undefined;
		// Public API doesn't allow including expired/hidden files by default
		const includeExpired = false;
		const includeHidden = false;

		console.log('Public list parameters:', { searchQuery, limit, cursor });

		const result = await getFilteredFiles(env, {
			searchQuery,
			limit: Math.min(limit, 100),
			cursor,
			includeExpired,
			includeHidden,
			caller,
		});

		return {
			success: result.success,
			files: result.files,
			totalFiles: result.files?.length || 0,
			expiredFiles: 0, // Not included in public view
			hiddenFiles: 0, // Not included in public view
			publicFiles: result.files?.length || 0,
			error: result.error,
		};
	} catch (error) {
		console.error('Public list error:', error);
		return {
			success: false,
			error: `Failed to list files: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

// Admin list handler - includes all files with comprehensive stats
export async function handleAdminList(request: Request, env: Env, caller?: any): Promise<AdminListResponse> {
	console.log('handleAdminList called (admin)');

	try {
		// Check if R2 bucket is available
		if (!env.R2_FILES) {
			console.error('R2_FILES bucket not available');
			return { success: false, error: 'Storage not configured' };
		}

		// Parse query parameters for filtering and pagination
		const url = new URL(request.url);
		const searchQuery = url.searchParams.get('search') || '';
		const limit = parseInt(url.searchParams.get('limit') || '100', 10);
		const cursor = url.searchParams.get('cursor') || undefined;
		// Admin API allows including expired and hidden files
		const includeExpired = url.searchParams.get('includeExpired') !== 'false'; // Default true for admin
		const includeHidden = url.searchParams.get('includeHidden') !== 'false'; // Default true for admin

		console.log('Admin list parameters:', { searchQuery, limit, cursor, includeExpired, includeHidden });

		// Get all files to calculate comprehensive stats (admin should see all irrespective of requiredRole)
		const allFilesResult = await getFilteredFiles(env, {
			searchQuery: '', // Get all files for stats calculation
			limit: 1000, // Higher limit for admin stats
			includeExpired: true,
			includeHidden: true,
			caller: { roles: ['admin'] }, // force admin view for stats calculation
		});

		if (!allFilesResult.success) {
			return {
				success: false,
				error: allFilesResult.error,
			};
		}

		// Calculate comprehensive stats
		const allFiles = allFilesResult.files || [];
		let totalSize = 0;
		let expiredCount = 0;
		let hiddenCount = 0;
		let publicCount = 0;
		let largestFileSize = 0;

		allFiles.forEach((file) => {
			totalSize += file.size || 0;
			largestFileSize = Math.max(largestFileSize, file.size || 0);

			if (file.isExpired) {
				expiredCount++;
			}

			if (file.hideFromList) {
				hiddenCount++;
			} else {
				publicCount++;
			}
		});

		const averageSize = allFiles.length > 0 ? totalSize / allFiles.length : 0;

		// Get filtered files for display (admin-level, so pass caller)
		const filteredResult = await getFilteredFiles(env, {
			searchQuery,
			limit: Math.min(limit, 100),
			cursor,
			includeExpired,
			includeHidden,
			caller,
		});

		if (!filteredResult.success) {
			return {
				success: false,
				error: filteredResult.error,
			};
		}

		return {
			success: true,
			files: filteredResult.files,
			stats: {
				totalFiles: allFiles.length,
				totalSize,
				averageSize,
				largestFileSize,
				expiredFiles: expiredCount,
				hiddenFiles: hiddenCount,
				publicFiles: publicCount,
			},
		};
	} catch (error) {
		console.error('Admin list error:', error);
		return {
			success: false,
			error: `Failed to list files: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

// Shared function to get filtered files
async function getFilteredFiles(
	env: Env,
	options: {
		searchQuery: string;
		limit: number;
		cursor?: string;
		includeExpired: boolean;
		includeHidden: boolean;
		caller?: any;
	}
): Promise<{ success: boolean; files?: FileListItem[]; error?: string }> {
	const { searchQuery, limit, cursor, includeExpired, includeHidden, caller } = options;

	const listOptions: R2ListOptions = {
		limit: Math.min(limit, 1000), // R2 max limit
		cursor: cursor,
		include: ['customMetadata'],
	};

	console.log('Listing R2 objects...');
	const listResult = await env.R2_FILES.list(listOptions);
	console.log(`Found ${listResult.objects.length} objects in R2`);

	const files: FileListItem[] = [];
	const now = new Date();

	// Normalize caller roles
	const callerRoles: string[] = caller && Array.isArray(caller.roles) && caller.roles.length ? caller.roles.map(String) : [];

	const isCallerAdmin = callerRoles.includes('admin');

	// Process each object and extract metadata
	for (const object of listResult.objects) {
		try {
			// Extract fileId from the object key (format: fileId/filename)
			const keyParts = object.key.split('/');
			const fileId = keyParts[0];
			const filename = keyParts.slice(1).join('/');

			// Read final KV metadata under `file:${fileId}` (consistent with upload-tus)
			let kvMetadata: any = {};
			if (env.FILE_METADATA) {
				try {
					const kvData = await env.FILE_METADATA.get(`file:${fileId}`);
					if (kvData) {
						kvMetadata = JSON.parse(kvData);
					}
				} catch (kvError) {
					console.warn(`Failed to get KV metadata for ${fileId}:`, kvError);
				}
			}

			// Extract custom metadata from R2 object
			const customMetadata = object.customMetadata || {};

			// Determine hideFromList
			const isHiddenFromList =
				customMetadata.hideFromList === 'true' ||
				customMetadata.hidefromlist === 'true' ||
				kvMetadata.hideFromList === true ||
				kvMetadata.hideFromList === 'true';

			if (isHiddenFromList && !includeHidden) {
				continue;
			}

			// Determine requiredRole
			const requiredRole =
				customMetadata.requiredRole ||
				customMetadata.requiredrole ||
				customMetadata.required_role ||
				kvMetadata.requiredRole ||
				kvMetadata.requiredrole ||
				kvMetadata.required_role ||
				'';

			// If requiredRole is set and caller does not have it (and caller isn't admin), skip
			if (requiredRole && typeof requiredRole === 'string' && requiredRole.trim() !== '') {
				const needed = requiredRole.trim();
				if (!isCallerAdmin && !callerRoles.includes(needed)) {
					// Caller not allowed to see this file
					continue;
				}
			}

			// Determine expiration (prefer R2 customMetadata, then KV)
			const expirationString = customMetadata.expiration || kvMetadata.expiration || '';
			let isExpired = false;
			let hoursUntilExpiration: number | undefined;

			if (expirationString) {
				try {
					const expirationDate = new Date(expirationString);
					if (expirationDate <= now) {
						isExpired = true;
					} else {
						hoursUntilExpiration = (expirationDate.getTime() - now.getTime()) / (1000 * 60 * 60);
					}
				} catch (dateError) {
					console.warn(`Invalid expiration date for ${fileId}: ${expirationString}`);
				}
			}

			if (isExpired && !includeExpired) {
				continue;
			}

			// Generate download url (same as before) — downloadUrl points to our download endpoint
			let downloadUrl = `/api/download/${fileId}`;
			let signedDownloadUrl: string | undefined;
			if (expirationString && !isExpired && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME) {
				try {
					const remainingSeconds = Math.floor((new Date(expirationString).getTime() - now.getTime()) / 1000);
					const urlExpirationSeconds = Math.max(300, Math.min(remainingSeconds, 3600)); // Min 5 minutes, Max 1 hour
					signedDownloadUrl = await generateSignedDownloadUrl(env, object.key, urlExpirationSeconds);
				} catch (signError) {
					console.warn(`Failed to generate signed URL for ${fileId}:`, signError);
				}
			}

			// Build searchable text using both R2 and KV metadata
			const searchableText = `${filename} ${customMetadata.description || kvMetadata.description || ''} ${
				customMetadata.tags || kvMetadata.tags || ''
			}`.toLowerCase();
			if (searchQuery && !searchableText.includes(searchQuery.toLowerCase())) {
				continue;
			}

			// Prefer explicit uploadType stored in R2 custom metadata or KV final record
			const uploadType =
				customMetadata.uploadType ||
				customMetadata.uploadtype ||
				kvMetadata.uploadType ||
				kvMetadata.uploadtype ||
				kvMetadata.upload_type ||
				'unknown';

			const fileItem: FileListItem = {
				fileId,
				filename: filename || customMetadata.originalName || kvMetadata.filename || 'Unknown',
				description: customMetadata.description || kvMetadata.description || '',
				tags: customMetadata.tags || kvMetadata.tags || '',
				expiration: expirationString || '',
				checksum: customMetadata.checksum || kvMetadata.checksum || '',
				uploadedAt: customMetadata.uploadedAt || kvMetadata.uploadedAt || object.uploaded?.toISOString() || '',
				size: object.size,
				contentType: object.httpMetadata?.contentType || kvMetadata.contentType || 'application/octet-stream',
				uploadType: uploadType,
				downloadUrl,
				// signedDownloadUrl,
				lastModified: object.uploaded?.toISOString() || '',
				etag: object.etag || '',
				isExpired,
				hoursUntilExpiration: hoursUntilExpiration ? Math.round(hoursUntilExpiration * 100) / 100 : undefined,
				hideFromList: isHiddenFromList,
				requiredRole: requiredRole || null,
			};

			// Optionally surface CF/user-agent metadata if present in customMetadata or KV
			if (customMetadata.asn || kvMetadata.asn) {
				(fileItem as any).asn = customMetadata.asn || kvMetadata.asn;
			}
			if (customMetadata.country || kvMetadata.country) {
				(fileItem as any).country = customMetadata.country || kvMetadata.country;
			}
			if (customMetadata.city || kvMetadata.city) {
				(fileItem as any).city = customMetadata.city || kvMetadata.city;
			}
			if (customMetadata.timezone || kvMetadata.timezone) {
				(fileItem as any).timezone = customMetadata.timezone || kvMetadata.timezone;
			}
			if (customMetadata.userAgent || kvMetadata.userAgent) {
				(fileItem as any).userAgent = customMetadata.userAgent || kvMetadata.userAgent;
			}

			files.push(fileItem);
		} catch (itemError) {
			console.error(`Error processing object ${object.key}:`, itemError);
		}
	}

	console.log(`Processed ${files.length} files successfully`);

	// Sort by uploadedAt desc
	files.sort((a, b) => {
		const dateA = new Date(a.uploadedAt || 0).getTime();
		const dateB = new Date(b.uploadedAt || 0).getTime();
		return dateB - dateA;
	});

	return { success: true, files };
}

async function generateSignedDownloadUrl(env: Env, objectKey: string, expiresInSeconds: number): Promise<string> {
	if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME) {
		throw new Error('Missing required R2 credentials for signed URLs');
	}

	// Create AWS client for R2
	const aws = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		region: 'auto',
		service: 's3',
	});

	const r2Endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	const objectUrl = `${r2Endpoint}/${env.R2_BUCKET_NAME}/${objectKey}`;

	console.log(`Generating signed URL for: ${objectUrl} with ${expiresInSeconds}s expiration`);

	try {
		// Create request with X-Amz-Expires query parameter
		const requestUrl = `${objectUrl}?X-Amz-Expires=${expiresInSeconds}`;
		const signedRequest = await aws.sign(new Request(requestUrl), {
			aws: { signQuery: true },
		});

		const signedUrl = signedRequest.url.toString();
		console.log('Generated signed URL successfully');

		return signedUrl;
	} catch (error) {
		console.error('Error generating signed URL:', error);
		throw new Error(`Failed to generate signed download URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}

// Helper function to clean up expired files from R2 and KV
export async function cleanupExpiredFiles(env: Env): Promise<{ success: boolean; deletedCount: number; error?: string }> {
	console.log('Starting cleanup of expired files...');

	try {
		if (!env.R2_FILES) {
			return { success: false, deletedCount: 0, error: 'R2_FILES bucket not available' };
		}

		const listResult = await env.R2_FILES.list({ limit: 100, include: ['customMetadata'] });
		console.log(`Found ${listResult.objects.length} objects in R2 for cleanup`);
		const now = new Date();
		let deletedCount = 0;

		for (const object of listResult.objects) {
			try {
				// Check if object has expiration metadata
				const expiration = object.customMetadata?.expiration;
				console.log(`R2 Custom Metadata Expiration: ${expiration} of object ${object.key}`);
				if (!expiration || expiration.trim() === '') continue;

				const expirationDate = new Date(expiration);
				console.log('Now:', now.toISOString(), 'Expiration:', expirationDate.toISOString());
				if (expirationDate <= now) {
					console.log(`Deleting expired object: ${object.key}`);

					// Delete from R2
					await env.R2_FILES.delete(object.key);

					// Delete from KV if available
					if (env.FILE_METADATA) {
						const fileId = object.key.split('/')[0];
						try {
							console.log(`Deleting KV metadata for fileId: ${fileId} ...`);
							await env.FILE_METADATA.delete(fileId);
							console.log(`Deleted KV metadata for ${fileId}`);
						} catch (kvError) {
							console.warn(`Failed to delete KV metadata for ${fileId}:`, kvError);
						}
					}

					deletedCount++;
				}
			} catch (objectError) {
				console.error(`Error processing object ${object.key} for cleanup:`, objectError);
			}
		}

		console.log(`Cleanup completed: deleted ${deletedCount} expired files`);
		return { success: true, deletedCount };
	} catch (error) {
		console.error('Cleanup error:', error);
		return {
			success: false,
			deletedCount: 0,
			error: `Cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

// Helper function to format file size
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to format date
export function formatDate(dateString: string): string {
	if (!dateString) return '';
	try {
		const date = new Date(dateString);
		return date.toLocaleString();
	} catch {
		return dateString;
	}
}

// Helper function to validate file expiration
export function validateFileExpiration(expirationString: string): { valid: boolean; date?: Date; error?: string } {
	if (!expirationString) {
		return { valid: true }; // No expiration is valid
	}

	try {
		const expirationDate = new Date(expirationString);
		const now = new Date();

		if (isNaN(expirationDate.getTime())) {
			return { valid: false, error: 'Invalid date format' };
		}

		if (expirationDate <= now) {
			return { valid: false, error: 'Expiration date must be in the future' };
		}

		// Check if expiration is too far in the future (e.g., more than 1 year)
		const maxFutureDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
		if (expirationDate > maxFutureDate) {
			return { valid: false, error: 'Expiration date cannot be more than 1 year in the future' };
		}

		return { valid: true, date: expirationDate };
	} catch (error) {
		return { valid: false, error: 'Failed to parse expiration date' };
	}
}
