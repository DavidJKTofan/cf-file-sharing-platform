// src/api/download.ts
import type { Env } from '../types';

type Caller = { email?: string; roles?: string[]; sub?: string; raw?: any } | undefined;

/**
 * handleDownload:
 * - fileId: identifier (prefix in R2 objects, and key used in KV final metadata).
 * - caller: optional object containing roles (set by middleware in index.ts).
 *
 * Authorization:
 * - If file has `requiredRole` metadata (in R2 customMetadata or KV `file:${fileId}` record),
 *   the caller must have that role (unless caller.roles includes 'admin').
 * - If no requiredRole set -> public access allowed (provided file not expired/hidden).
 *
 * Response:
 * - On success, stream object body back with content-type and content-disposition.
 * - 404 if not found, 403 if caller lacks role, 410 if expired.
 */
export async function handleDownload(_request: Request, env: Env, fileId: string, caller?: Caller): Promise<Response> {
	try {
		if (!env.R2_FILES) {
			return new Response(JSON.stringify({ success: false, error: 'Storage not configured' }), {
				status: 500,
				headers: { 'content-type': 'application/json' },
			});
		}

		// Normalize caller roles
		const callerRoles = Array.isArray(caller && caller.roles) ? (caller!.roles as string[]).map(String) : [];
		const isCallerAdmin = callerRoles.includes('admin');

		// Try KV final metadata first
		let kvMetadata: any = null;
		if (env.FILE_METADATA) {
			try {
				const raw = await env.FILE_METADATA.get(`file:${fileId}`);
				if (raw) {
					kvMetadata = JSON.parse(raw);
				}
			} catch (err) {
				console.warn('Failed to read KV metadata for download', err);
			}
		}

		// Candidate R2 key
		let r2Key: string | undefined = kvMetadata?.r2Key || kvMetadata?.r2key;

		// If KV had no r2Key, find the first R2 object with prefix `fileId/`
		if (!r2Key) {
			const list = await env.R2_FILES.list({ prefix: `${fileId}/`, limit: 10, include: ['customMetadata'] });
			if (!list || !list.objects || list.objects.length === 0) {
				return new Response(JSON.stringify({ success: false, error: 'File not found' }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				});
			}
			// pick first object
			r2Key = list.objects[0].key;
			// Merge R2 customMetadata if kvMetadata missing
			if (!kvMetadata) {
				kvMetadata = list.objects[0].customMetadata || {};
			}
		}

		// Retrieve object metadata to check customMetadata, expiration etc.
		const headObj = await env.R2_FILES.head(r2Key);
		if (!headObj) {
			// object not found
			return new Response(JSON.stringify({ success: false, error: 'File not found' }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		}

		const customMetadata = headObj.customMetadata || {};

		// Determine requiredRole from customMetadata or KV
		const requiredRole =
			(customMetadata.requiredRole as string) ||
			(customMetadata.requiredrole as string) ||
			(customMetadata.required_role as string) ||
			(kvMetadata && (kvMetadata.requiredRole || kvMetadata.requiredrole || kvMetadata.required_role)) ||
			'';

		if (requiredRole && requiredRole.trim() !== '') {
			const needed = requiredRole.trim();
			if (!isCallerAdmin && !callerRoles.includes(needed)) {
				return new Response(JSON.stringify({ success: false, error: 'Forbidden: required role not present' }), {
					status: 403,
					headers: { 'content-type': 'application/json' },
				});
			}
		}

		// Check hideFromList / expiration: allow download if not expired (but admin can still download)
		const expiration = customMetadata.expiration || (kvMetadata && kvMetadata.expiration) || '';
		if (expiration) {
			const expDate = new Date(expiration);
			if (!isNaN(expDate.getTime()) && expDate <= new Date()) {
				return new Response(JSON.stringify({ success: false, error: 'File expired' }), {
					status: 410,
					headers: { 'content-type': 'application/json' },
				});
			}
		}

		// Fetch object body
		const object = await env.R2_FILES.get(r2Key);
		if (!object || !object.body) {
			return new Response(JSON.stringify({ success: false, error: 'File data missing' }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		}

		// Build response and stream the body
		const filename = (kvMetadata && kvMetadata.filename) || customMetadata.originalName || r2Key.split('/').slice(1).join('/') || 'file';
		const contentType = (object.httpMetadata && object.httpMetadata.contentType) || 'application/octet-stream';

		const headers: Record<string, string> = {
			'content-type': contentType,
			'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
		};

		// Optional: expose metadata
		headers['x-file-id'] = fileId;
		if (customMetadata.checksum || kvMetadata?.checksum) headers['x-file-checksum'] = customMetadata.checksum || kvMetadata.checksum;

		return new Response(object.body, { status: 200, headers });
	} catch (err) {
		console.error('handleDownload error', err);
		return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
			status: 500,
			headers: { 'content-type': 'application/json' },
		});
	}
}
