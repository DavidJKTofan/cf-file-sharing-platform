// src/api/download.ts
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import { AwsClient } from 'aws4fetch';
import type { Env, User } from '../types';

const downloadParamsSchema = z.object({
	fileId: z.string().uuid(),
});

/**
 * handleDownload:
 * - Extracts fileId from the request parameters and validates user authorization.
 * - In production: Generates a short-lived, presigned URL for direct R2 download and
 *   returns a 302 redirect. This offloads bandwidth from the Worker and avoids egress fees.
 * - In development: Streams the file through the Worker. This is compatible with
 *   Wrangler's local development environment, which does not use S3 credentials.
 */
export async function handleDownload(c: Context<{ Bindings: Env; Variables: { user?: User } }>): Promise<Response> {
	const { fileId } = downloadParamsSchema.parse(c.req.param());
	const { env, req } = c;
	const { config } = env;
	const caller = c.get('user');

	// --- Authorization and Metadata Fetching ---
	const callerRoles = caller?.roles || [];
	const isCallerAdmin = callerRoles.includes('admin');

	let kvMetadata: any = null;
	if (env.FILE_METADATA) {
		const raw = await env.FILE_METADATA.get(`file:${fileId}`);
		if (raw) kvMetadata = JSON.parse(raw);
	}

	let r2Key = kvMetadata?.r2Key;
	if (!r2Key) {
		const list = await env.R2_FILES.list({ prefix: `${fileId}/`, limit: 1 });
		if (!list.objects.length) throw new HTTPException(404, { message: 'File not found.' });
		r2Key = list.objects[0].key;
	}

	const headObj = await env.R2_FILES.head(r2Key);
	if (!headObj) throw new HTTPException(404, { message: 'File not found in storage.' });

	const customMetadata = { ...headObj.customMetadata, ...kvMetadata };

	const requiredRole = customMetadata.requiredRole || customMetadata.requiredrole;
	if (requiredRole && !isCallerAdmin && !callerRoles.includes(requiredRole)) {
		throw new HTTPException(403, { message: 'Access denied. Required role not met.' });
	}

	if (customMetadata.expiration) {
		const expirationDate = new Date(customMetadata.expiration);
		if (expirationDate <= new Date()) throw new HTTPException(410, { message: 'This file has expired.' });
	}
	// --- End Authorization ---

	// --- Environment-Specific Download Logic ---
	if (config.ENVIRONMENT === 'production') {
		// --- Production: Presigned URL Generation ---
		const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
		const { R2_ACCOUNT_ID, R2_BUCKET_NAME } = config;

		if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
			console.error('[ERROR] R2 credentials for signing are not configured for production.');
			throw new HTTPException(500, { message: 'R2 credentials for signing are not configured for production.' });
		}

		if (config.ENVIRONMENT === 'production') {
			console.log(
				`[INFO] Generating presigned URL for: bucket=${R2_BUCKET_NAME}, key=${r2Key}, endpoint=https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
			);
		}

		const aws = new AwsClient({
			accessKeyId: R2_ACCESS_KEY_ID,
			secretAccessKey: R2_SECRET_ACCESS_KEY,
			service: 's3',
			region: 'auto',
		});

		const url = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${r2Key}`);
		url.searchParams.set('X-Amz-Expires', '600'); // 10 minutes

		const signedRequest = await aws.sign(url.href, {
			aws: { signQuery: true },
		});

		return c.redirect(signedRequest.url, 302);
	} else {
		// --- Development: Worker-Streamed Download ---
		const object = await env.R2_FILES.get(r2Key);
		if (!object) {
			throw new HTTPException(404, { message: 'File data could not be retrieved.' });
		}

		// Sanitize filename for headers
		const filename = customMetadata.originalName || r2Key.split('/').pop() || 'file';
		const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '');

		const headers = new Headers();
		headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
		headers.set('Content-Length', String(object.size));
		headers.set('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
		if (object.httpEtag) headers.set('ETag', object.httpEtag);
		if (customMetadata.checksum) headers.set('x-file-checksum', customMetadata.checksum);

		return new Response(object.body, { headers });
	}
}
