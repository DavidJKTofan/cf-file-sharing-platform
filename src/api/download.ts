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

	// Helper: sanitize a filename for use in headers and as fallback
	function sanitizeFilename(input?: string | null): string {
		if (!input) return '';
		// strip control chars (including newlines), trim
		let name = String(input)
			.replace(/[\u0000-\u001F\u007F]/g, '')
			.trim();
		// remove any path components
		name = name.split(/[\\/]+/).pop() || name;
		// collapse whitespace
		name = name.replace(/\s+/g, ' ');
		// limit length (some browsers choke on very long names)
		if (name.length > 250) name = name.slice(0, 250);
		// final trim
		return name || '';
	}

	function makeAsciiFallback(name: string): string {
		// Replace non-ASCII characters with underscore so header `filename=` is ASCII-only
		const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
		return fallback || 'file';
	}

	function quoteFilenameForHeader(name: string): string {
		// escape quotes and backslashes for a quoted-string
		return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	}

	// Candidate filenames in preferred order:
	// 1) explicit ?filename= query param (if provided)
	// 2) kvMetadata.filename (if present)
	// 3) customMetadata.filename or customMetadata.originalName
	// 4) last segment of r2Key
	// 5) fallback 'file'
	const requestedFilenameRaw = c.req.query('filename') || null;

	const derivedFromKey = (() => {
		try {
			const seg = r2Key.split('/').pop() || '';
			// decode percent-encoding if present
			return decodeURIComponent(seg);
		} catch (e) {
			return r2Key.split('/').pop() || '';
		}
	})();

	const candidates = [requestedFilenameRaw, kvMetadata?.filename, customMetadata?.filename, customMetadata?.originalName, derivedFromKey];

	let chosen = '';
	for (const cand of candidates) {
		const s = sanitizeFilename(cand);
		if (s) {
			chosen = s;
			break;
		}
	}
	if (!chosen) chosen = 'file';

	// Build header-safe variants
	const utf8Name = chosen; // original UTF-8 name
	const asciiFallback = makeAsciiFallback(utf8Name);
	const quotedAscii = quoteFilenameForHeader(asciiFallback);

	// Content-Type (fall back to generic) and Content-Length if available
	const contentType = (object.httpMetadata && object.httpMetadata.contentType) || 'application/octet-stream';

	const headers = new Headers();
	headers.set('Content-Type', contentType);
	if (typeof object.size === 'number') {
		headers.set('Content-Length', String(object.size));
	}
	// Set both filename (ASCII-safe quoted) and filename* (RFC5987 UTF-8)
	// Example: Content-Disposition: attachment; filename="report.pdf"; filename*=UTF-8''report%20with%20utf8.pdf
	const disposition = `attachment; filename="${quotedAscii}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
	headers.set('Content-Disposition', disposition);

	if (object.httpEtag) headers.set('ETag', object.httpEtag);

	if (customMetadata.checksum) {
		headers.set('x-file-checksum', customMetadata.checksum);
	}

	return new Response(object.body, { headers });
}
