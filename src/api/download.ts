// src/api/download.ts
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { Env, User } from '../types';

/**
 * handleDownload:
 * - Extracts fileId from the request parameters.
 * - Extracts the caller (user) from the context.
 *
 * Authorization:
 * - If a file has a `requiredRole`, the caller must have that role or be an admin.
 * - Public access is allowed for files without a required role, provided they are not expired.
 *
 * Response:
 * - Streams the R2 object body with appropriate headers on success.
 * - Throws HTTPException for errors like not found, forbidden, or expired.
 */
export async function handleDownload(c: Context<{ Bindings: Env; Variables: { user?: User } }>): Promise<Response> {
	const fileId = c.req.param('fileId');
	const env = c.env;
	const caller = c.get('user');

	if (!env.R2_FILES) {
		throw new HTTPException(500, { message: 'File storage is not configured.' });
	}

	const callerRoles = caller?.roles || [];
	const isCallerAdmin = callerRoles.includes('admin');

	// Attempt to retrieve metadata from KV first
	let kvMetadata: any = null;
	if (env.FILE_METADATA) {
		try {
			const raw = await env.FILE_METADATA.get(`file:${fileId}`);
			if (raw) kvMetadata = JSON.parse(raw);
		} catch (err) {
			console.warn(`KV metadata fetch failed for ${fileId}:`, err);
		}
	}

	// Determine the R2 object key
	let r2Key = kvMetadata?.r2Key;
	if (!r2Key) {
		const list = await env.R2_FILES.list({ prefix: `${fileId}/`, limit: 1 });
		if (!list.objects.length) {
			throw new HTTPException(404, { message: 'File not found.' });
		}
		r2Key = list.objects[0].key;
	}

	// Retrieve the object from R2 to verify existence and metadata
	if (c.env.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] Retrieving head for R2 object: ${r2Key}`);
		console.log(`[DEBUG] Caller:`, JSON.stringify(caller, null, 2));
	}
	const headObj = await env.R2_FILES.head(r2Key);
	if (!headObj) {
		throw new HTTPException(404, { message: 'File not found in storage.' });
	}
	if (c.env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] R2 head object retrieved:', JSON.stringify(headObj, null, 2));
	}

	const customMetadata = { ...headObj.customMetadata, ...kvMetadata };
	if (c.env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] Combined metadata:', JSON.stringify(customMetadata, null, 2));
	}

	// Enforce role-based access control
	const requiredRole = customMetadata.requiredRole || customMetadata.requiredrole;
	if (c.env.ENVIRONMENT === 'development') {
		console.log(`[DEBUG] Required role: '${requiredRole}'. Caller roles: [${callerRoles.join(', ')}]`);
	}
	if (requiredRole && !isCallerAdmin && !callerRoles.includes(requiredRole)) {
		throw new HTTPException(403, { message: 'Access denied. Required role not met.' });
	}

	// Check for file expiration
	if (customMetadata.expiration) {
		const expirationDate = new Date(customMetadata.expiration);
		if (expirationDate <= new Date()) {
			throw new HTTPException(410, { message: 'This file has expired.' });
		}
	}

	// Get the object and stream its body
	const object = await env.R2_FILES.get(r2Key);
	if (!object) {
		throw new HTTPException(404, { message: 'File data could not be retrieved.' });
	}

	const headers = new Headers({
		'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
		'Content-Disposition': `attachment; filename="${customMetadata.filename || fileId}"`,
		ETag: object.httpEtag,
	});

	if (customMetadata.checksum) {
		headers.set('x-file-checksum', customMetadata.checksum);
	}

	return new Response(object.body, { headers });
}
