// src/index.ts
import { Hono, type HonoRequest, type Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import type { Env, User } from './types';

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

// --- UTILITY FUNCTIONS ---

function decodeJwtPayload(token: string) {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const pad = payloadB64.length % 4;
		const padded = pad ? payloadB64 + '='.repeat(4 - pad) : payloadB64;
		const decoded = atob(padded);
		return JSON.parse(decoded);
	} catch (err) {
		console.error('Failed to decode JWT payload:', err);
		return null;
	}
}

function getJwt(req: HonoRequest): string | null {
	const fromHeader = req.header('cf-access-jwt-assertion');
	if (fromHeader) return fromHeader;

	const cookie = req.header('cookie') || '';
	const match = cookie.match(/CF_Authorization=([^;]+)/);
	if (match?.[1]) return decodeURIComponent(match[1]);

	return null;
}

async function getUserRolesFromD1(env: Env, email: string): Promise<string[]> {
	if (!env.ROLES_DB || !email) return ['user'];
	try {
		const stmt = env.ROLES_DB.prepare('SELECT roles FROM user_roles WHERE email = ?1 LIMIT 1');
		const row = await stmt.bind(email).first<{ roles: string | string[] }>();

		if (!row?.roles) return ['user'];

		if (typeof row.roles === 'string') {
			try {
				const parsed = JSON.parse(row.roles);
				return Array.isArray(parsed) ? parsed.map(String) : [String(row.roles)];
			} catch {
				return row.roles
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
			}
		}
		return Array.isArray(row.roles) ? row.roles.map(String) : ['user'];
	} catch (err) {
		console.warn(`D1 role lookup for ${email} failed:`, err);
		return ['user'];
	}
}

// --- MIDDLEWARE ---

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

app.use('*', async (c, next) => {
	const defaultOrigin = 'https://files.automatic-demo.com';
	const appUrl = c.env.APP_URL;
	const isProduction = c.env.ENVIRONMENT === 'production';

	let origin = defaultOrigin;
	if (appUrl) {
		try {
			origin = new URL(appUrl).origin;
		} catch {
			console.warn(`Invalid APP_URL: "${appUrl}". Falling back to default origin.`);
		}
	} else if (isProduction) {
		console.warn('APP_URL is not set in production. CORS may be too restrictive.');
	}

	const corsMiddleware = cors({
		origin: isProduction ? origin : '*',
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
		'X-Frame-Options': 'SAMEORIGIN',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
		'Content-Security-Policy':
			"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self';",
	};
	for (const [key, value] of Object.entries(headers)) {
		c.header(key, value);
	}
});

const PUBLIC_USER: User = { email: 'public', sub: 'public', roles: ['public'], raw: null };

const optionalAuthenticate = createMiddleware(async (c, next) => {
	// In development, allow using a mock user defined in .dev.vars to bypass JWT validation.
	if (c.env.ENVIRONMENT !== 'production' && c.env.DEV_USER_EMAIL) {
		const email = c.env.DEV_USER_EMAIL;
		const roles = c.env.DEV_USER_ROLES ? c.env.DEV_USER_ROLES.split(',').map((s: string) => s.trim()) : ['admin', 'sme', 'user'];
		c.set('user', {
			email,
			sub: 'dev-user',
			roles,
			raw: { note: 'This is a mock user for development. Authentication is bypassed.' },
		});
		return await next();
	}

	const token = getJwt(c.req);
	if (!token) {
		c.set('user', PUBLIC_USER);
		return next();
	}

	const payload = decodeJwtPayload(token);
	if (!payload) {
		c.set('user', PUBLIC_USER);
		return next();
	}

	if (c.env.ENVIRONMENT === 'production' && payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
		c.set('user', PUBLIC_USER);
		return next();
	}

	const email = String(payload.email || payload.upn || payload.sub || 'unknown');
	const roles =
		Array.isArray(payload.roles) && payload.roles.length > 0 ? payload.roles.map(String) : await getUserRolesFromD1(c.env, email);

	c.set('user', { email, sub: String(payload.sub || ''), roles, raw: payload });
	await next();
});

const authenticateUser = createMiddleware(async (c, next) => {
	// In development, allow using a mock user defined in .dev.vars to bypass JWT validation.
	if (c.env.ENVIRONMENT !== 'production' && c.env.DEV_USER_EMAIL) {
		const email = c.env.DEV_USER_EMAIL;
		const roles = c.env.DEV_USER_ROLES ? c.env.DEV_USER_ROLES.split(',').map((s: string) => s.trim()) : ['admin', 'sme', 'user'];
		c.set('user', {
			email,
			sub: 'dev-user',
			roles,
			raw: { note: 'This is a mock user for development. Authentication is bypassed.' },
		});
		return await next();
	}

	const token = getJwt(c.req);
	if (!token) {
		// For development, provide a more helpful error message.
		if (c.env.ENVIRONMENT !== 'production') {
			throw new HTTPException(401, {
				message:
					'Authentication token not found. In development, you can bypass this by setting DEV_USER_EMAIL and optionally DEV_USER_ROLES in your .dev.vars file.',
			});
		}
		throw new HTTPException(401, { message: 'Authentication token not found' });
	}

	const payload = decodeJwtPayload(token);
	if (!payload) throw new HTTPException(401, { message: 'Invalid token format' });

	if (c.env.ENVIRONMENT === 'production' && payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
		throw new HTTPException(401, { message: 'Token has expired' });
	}

	const email = String(payload.email || payload.upn || payload.sub || 'unknown');
	const roles =
		Array.isArray(payload.roles) && payload.roles.length > 0 ? payload.roles.map(String) : await getUserRolesFromD1(c.env, email);

	c.set('user', { email, sub: String(payload.sub || ''), roles, raw: payload });
	await next();
});

const requireRole = (required: string | string[]) => {
	const requiredRoles = Array.isArray(required) ? required : [required];
	return createMiddleware(async (c, next) => {
		const user = c.get('user');
		if (!user || !user.roles.some((role: string) => requiredRoles.includes(role))) {
			throw new HTTPException(403, { message: `Access denied. Required role: ${requiredRoles.join(' or ')}` });
		}
		await next();
	});
};

// --- ROUTES ---

app.get('/', (c) => c.text('File Sharing Worker is running.'));

const publicApi = new Hono<{ Bindings: Env; Variables: { user?: User } }>();
publicApi.use('*', optionalAuthenticate);
publicApi.get('/list', (c) => handleList(c));
publicApi.get('/download/:fileId', (c) => handleDownload(c));

const authApi = new Hono<{ Bindings: Env; Variables: { user: User } }>();
authApi.use('*', authenticateUser);

authApi.get('/debug/jwt', (c) => c.json({ success: true, extractedUser: c.get('user'), rawJwtPayload: c.get('user').raw }));
authApi.post('/admin/upload', requireRole(['admin', 'sme']), (c) => handleUpload(c));
authApi.get('/admin/list', requireRole('admin'), (c) => handleAdminList(c));
authApi.post('/admin/cleanup', requireRole('admin'), (c) => cleanupExpiredFiles(c));
authApi.get('/admin/r2-info', requireRole('admin'), (c) => {
	const { R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: bucketName } = c.env;
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
