import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Env, User } from './types';
import { defineConfig } from './config';
import { authenticate, requireRole } from './auth';

import { handleUpload } from './api/upload';
import { handleList, handleAdminList, cleanupExpiredFiles } from './api/list';
import { handleDownload } from './api/download';
import {
	handleTusUploadCreation,
	handleTusUploadChunk,
	handleTusUploadHead,
	handleTusUploadDelete,
	handleTusOptions,
} from './api/upload-tus';

// --- MIDDLEWARE ---

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const configMiddleware = createMiddleware(async (c, next) => {
	if (!c.env.config) {
		c.env.config = defineConfig(c.env);
	}
	await next();
});

app.use('*', configMiddleware);

app.use('*', async (c, next) => {
	const { config } = c.env;
	const isProduction = config.ENVIRONMENT === 'production';

	const corsMiddleware = cors({
		origin: isProduction ? config.APP_URL : '*',
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'cf-access-jwt-assertion',
			'Tus-Resumable',
			'Upload-Length',
			'Upload-Metadata',
			'Upload-Offset',
		],
		exposeHeaders: ['Location', 'Tus-Resumable', 'Tus-Upload-Offset'],
	});

	await corsMiddleware(c, next);
});

app.use('*', async (c, next) => {
	await next();
	const headers = {
		'X-Frame-Options': 'DENY',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
		'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; upgrade-insecure-requests;",
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	};
	for (const [key, value] of Object.entries(headers)) {
		c.header(key, value);
	}
});

// --- ROUTES ---

app.get('/', (c) => c.text('File Sharing Worker is running.'));

const publicApi = new Hono<{ Bindings: Env; Variables: { user?: User } }>();
publicApi.use('*', authenticate({ optional: true }));
publicApi.get('/list', (c) => handleList(c));
publicApi.get('/download/:fileId', (c) => handleDownload(c));

const authApi = new Hono<{ Bindings: Env; Variables: { user: User } }>();
authApi.use('*', authenticate({ optional: false }));

authApi.get('/debug/jwt', (c) => c.json({ success: true, extractedUser: c.get('user'), rawJwtPayload: c.get('user').raw }));
authApi.post('/admin/upload', requireRole(['admin', 'sme']), (c) => handleUpload(c));
authApi.get('/admin/list', requireRole('admin'), (c) => handleAdminList(c));
authApi.post('/admin/cleanup', requireRole('admin'), (c) => cleanupExpiredFiles(c));
authApi.get('/admin/r2-info', requireRole('admin'), (c) => {
	const { R2_ACCOUNT_ID: accountId } = c.env;
	const { R2_BUCKET_NAME: bucketName } = c.env.config;
	if (!accountId || !bucketName) throw new HTTPException(500, { message: 'R2 configuration is missing' });
	return c.json({ success: true, accountId, bucketName });
});

authApi.post('/upload/tus', requireRole(['admin', 'sme']), (c) => handleTusUploadCreation(c));
authApi.patch('/upload/tus/:fileId', requireRole(['admin', 'sme']), (c) => handleTusUploadChunk(c));
authApi.on('HEAD', '/upload/tus/:fileId', requireRole(['admin', 'sme']), (c) => handleTusUploadHead(c));
authApi.delete('/upload/tus/:fileId', requireRole(['admin', 'sme']), (c) => handleTusUploadDelete(c));

app.options('/api/upload/tus', handleTusOptions);
app.options('/api/upload/tus/:fileId', handleTusOptions);

app.route('/api', publicApi);
app.route('/api', authApi);

// FIXED ERROR HANDLER - Returns JSON responses
app.onError((err, c) => {
	if (err instanceof z.ZodError) {
		return c.json(
			{
				success: false,
				error: 'Invalid input',
				issues: err.flatten().fieldErrors,
			},
			400
		);
	}
	if (err instanceof HTTPException) {
		// Log server errors (5xx) but not client errors (4xx)
		if (err.status >= 500) {
			console.error(`Server error: ${err.message}`, err);
		}

		// Return JSON response for all HTTPExceptions
		return c.json(
			{
				success: false,
				error: err.message || 'An error occurred',
			},
			err.status
		);
	}

	// For unexpected errors, log the full error and return JSON
	console.error('Unhandled error:', err);
	return c.json(
		{
			success: false,
			error: 'Internal Server Error',
		},
		500
	);
});

export default app;
