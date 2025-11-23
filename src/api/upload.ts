import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, User } from '../types';

const uploadFormSchema = z.object({
	file: z.instanceof(File),
	description: z.string().optional(),
	tags: z.string().optional(),
	expiration: z.string().optional(),
	checksum: z.string().optional(),
	hideFromList: z.string().transform((s) => s.toLowerCase() === 'true').optional(),
	requiredRole: z.string().optional(),
});

export async function handleUpload(c: Context<{ Bindings: Env; Variables: { user: User } }>): Promise<Response> {
	const { req, env } = c;
	const { config } = env;

	const contentType = req.header('content-type') || '';
	if (!contentType.includes('multipart/form-data')) {
		throw new HTTPException(400, { message: 'Invalid content type. Expected multipart/form-data.' });
	}

	const formData = await req.formData();
	const validated = uploadFormSchema.safeParse({
		file: formData.get('file'),
		description: formData.get('description'),
		tags: formData.get('tags'),
		expiration: formData.get('expiration'),
		checksum: formData.get('checksum'),
		hideFromList: formData.get('hideFromList'),
		requiredRole: formData.get('requiredRole'),
	});

	if (!validated.success) {
		throw new HTTPException(400, { message: 'Invalid form data', cause: validated.error });
	}

	const { file, description, tags, expiration, checksum, hideFromList, requiredRole } = validated.data;

	if (file.size > config.MAX_TOTAL_FILE_SIZE) {
		throw new HTTPException(413, {
			message: `File exceeds maximum allowed size of ${config.MAX_TOTAL_FILE_SIZE / 1024 / 1024}MB.`,
		});
	}

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
		description: description || '',
		tags: tags || '',
		expiration: expirationDate ? expirationDate.toISOString() : '',
		checksum: checksum || '',
		originalName: file.name,
		uploadedAt: new Date().toISOString(),
		hideFromList: String(hideFromList || false),
		requiredRole: requiredRole || '',
		uploadType: 'multipart',
		asn: String(cf.asn || ''),
		country: cf.country || '',
		city: cf.city || '',
		timezone: cf.timezone || '',
		userAgent: req.header('User-Agent') || '',
	};

	if (config.ENVIRONMENT === 'development') {
		console.log('[DEBUG] Uploading file with metadata:', JSON.stringify(customMetadata, null, 2));
	}

	await env.R2_FILES.put(objectKey, file.stream(), {
		httpMetadata: { contentType: file.type },
		customMetadata,
	});

	const downloadUrl = `${config.APP_URL}/api/download/${fileId}`;

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
