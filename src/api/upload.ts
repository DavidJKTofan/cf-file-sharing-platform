import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { AwsClient } from 'aws4fetch';
import type { Env, User } from '../types';

// ... (interfaces and constants remain the same)

export async function handleUpload(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;

	const contentType = req.header('content-type') || '';
	if (!contentType.includes('multipart/form-data')) {
		throw new HTTPException(400, { message: 'Invalid content type. Expected multipart/form-data.' });
	}

	const formData = await req.formData();
	const file = formData.get('file');

	if (!(file instanceof File)) {
		throw new HTTPException(400, { message: 'A valid file is required.' });
	}

	const maxSize = env.MAX_TOTAL_FILE_SIZE || 100 * 1024 * 1024; // Default 100MB
	if (file.size > maxSize) {
		throw new HTTPException(413, { message: `File exceeds maximum allowed size of ${maxSize / 1024 / 1024}MB.` });
	}

	const description = (formData.get('description') as string) || '';
	const tags = (formData.get('tags') as string) || '';
	const expiration = (formData.get('expiration') as string) || '';
	const checksum = (formData.get('checksum') as string) || '';
	const hideFromList = (formData.get('hideFromList') as string)?.toLowerCase() === 'true';
	const requiredRole = (formData.get('requiredRole') as string) || '';

	let expirationDate: Date | null = null;
	if (expiration) {
		expirationDate = new Date(expiration);
		if (isNaN(expirationDate.getTime()) || expirationDate <= new Date()) {
			throw new HTTPException(400, { message: 'Expiration date must be in the future.' });
		}
	}

	const fileId = crypto.randomUUID();
	const objectKey = `${fileId}/${file.name}`;
	const cf = (req.raw as any).cf || {};

	const customMetadata: Record<string, string> = {
		fileId,
		description,
		tags,
		expiration: expirationDate ? expirationDate.toISOString() : '',
		checksum,
		originalName: file.name,
		uploadedAt: new Date().toISOString(),
		hideFromList: String(hideFromList),
		requiredRole,
		uploadType: 'multipart',
		asn: String(cf.asn || ''),
		country: cf.country || '',
		city: cf.city || '',
		timezone: cf.timezone || '',
		userAgent: req.header('User-Agent') || '',
	};

	if (c.env.ENVIRONMENT === 'development') {
		console.log('[DEBUG] Uploading file with metadata:', JSON.stringify(customMetadata, null, 2));
	}

	if (!env.R2_FILES) {
		throw new HTTPException(500, { message: 'File storage is not configured.' });
	}

	await env.R2_FILES.put(objectKey, file.stream(), {
		httpMetadata: { contentType: file.type },
		customMetadata,
	});

	const downloadUrl = `${new URL(req.url).origin}/api/download/${fileId}`;

	const responsePayload = {
		success: true,
		fileId,
		filename: file.name,
		downloadUrl,
		...customMetadata,
	};

	if (env.FILE_METADATA) {
		await env.FILE_METADATA.put(`file:${fileId}`, JSON.stringify(responsePayload));
	}

	return c.json(responsePayload, 201);
}
