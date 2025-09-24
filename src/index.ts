// src/index.ts
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import type { Env } from './types';

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

/**
 * RBAC + TUS-enabled Hono worker with:
 * - optionalAuthenticate: does NOT require token; sets user to 'public' if no token provided.
 * - authenticateUser: strict; requires valid token (used for protected endpoints).
 * - D1-backed role lookup fallback (ROLES_DB binding) when roles are not present inside the JWT.
 */

// Helper: decode JWT payload safely
function decodeJwtPayload(token: string | null) {
	if (!token) return null;
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const pad = payloadB64.length % 4;
		const padded = pad ? payloadB64 + '='.repeat(4 - pad) : payloadB64;
		// atob available in Workers
		const decoded = atob(padded);
		return JSON.parse(decoded);
	} catch (err) {
		return null;
	}
}

// D1-backed role lookup (fallback)
async function getUserRolesFromD1(env: Env | unknown, email: string): Promise<string[]> {
	try {
		const d1 = (env as any).ROLES_DB;
		if (!d1 || !email) return ['user'];

		// Prepare & execute query. The D1 API varies between SDK versions;
		// this uses the D1 `prepare().bind().first()` pattern used in many examples.
		const stmt = d1.prepare('SELECT roles FROM user_roles WHERE email = ? LIMIT 1');
		const row = await stmt.bind(email).first();
		if (!row) return ['user'];

		const raw = row.roles;
		if (!raw) return ['user'];

		if (typeof raw === 'string') {
			// Try JSON array
			try {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) return parsed.map(String);
			} catch {
				// fallback to CSV
				const parts = raw
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
				if (parts.length) return parts;
				return [raw.trim()];
			}
		} else if (Array.isArray(raw)) {
			return raw.map(String);
		} else {
			return [String(raw)];
		}
	} catch (err) {
		console.warn('D1 role lookup failed', err);
		return ['user'];
	}
	// safety
	return ['user'];
}

type User = {
	email: string;
	sub: string;
	roles: string[];
	raw: any;
};

const app = new Hono<{ Bindings: Env; Variables: { user?: User } }>();

// CORS (adjust origin in production)
app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'cf-access-jwt-assertion',
			'Cookie',
			'Tus-Resumable',
			'Upload-Length',
			'Upload-Metadata',
			'Upload-Offset',
		],
	})
);

/**
 * optionalAuthenticate:
 * - If token present and valid -> sets user (email, sub, roles).
 * - If no token -> sets a lightweight public user { email: 'public', roles: ['public'] }.
 * This allows public endpoints (/api/list, /api/download) to function without auth.
 */
const optionalAuthenticate = createMiddleware(async (c, next) => {
	let token = c.req.header('cf-access-jwt-assertion') || '';

	if (!token) {
		const cookie = c.req.header('cookie') || '';
		const m = cookie.match(/CF_Authorization=([^;]+)/);
		if (m) token = decodeURIComponent(m[1]);
	}

	if (!token) {
		// No token — treat as public user
		const publicUser: User = {
			email: 'public',
			sub: '',
			roles: ['public'],
			raw: null,
		};
		c.set('user', publicUser);
		await next();
		return;
	}

	try {
		const payload = decodeJwtPayload(token);
		if (!payload) {
			// token present but invalid -> treat as unauthenticated (public)
			const publicUser: User = {
				email: 'public',
				sub: '',
				roles: ['public'],
				raw: null,
			};
			c.set('user', publicUser);
			await next();
			return;
		}

		// Optional expiry check in production
		if (c.env.ENVIRONMENT === 'production') {
			if (payload.exp && typeof payload.exp === 'number') {
				const now = Math.floor(Date.now() / 1000);
				if (payload.exp < now) {
					// expired: treat as public
					const publicUser: User = {
						email: 'public',
						sub: '',
						roles: ['public'],
						raw: null,
					};
					c.set('user', publicUser);
					await next();
					return;
				}
			}
		}

		const email = String(payload.email || payload.upn || payload.sub || 'unknown');

		let roles: string[] = [];
		if (Array.isArray(payload.roles) && payload.roles.length) {
			roles = payload.roles.map(String);
		} else {
			roles = await getUserRolesFromD1(c.env as Env, email);
		}

		const user: User = {
			email,
			sub: String(payload.sub || ''),
			roles,
			raw: payload,
		};
		c.set('user', user);
		await next();
	} catch (err) {
		console.error('optionalAuthenticate error:', err);
		// fallback to public user
		const publicUser: User = {
			email: 'public',
			sub: '',
			roles: ['public'],
			raw: null,
		};
		c.set('user', publicUser);
		await next();
	}
});

/**
 * authenticateUser - strict middleware (throws 401 if no valid token)
 */
const authenticateUser = createMiddleware(async (c, next) => {
	let token = c.req.header('cf-access-jwt-assertion') || '';

	if (!token) {
		const cookie = c.req.header('cookie') || '';
		const m = cookie.match(/CF_Authorization=([^;]+)/);
		if (m) token = decodeURIComponent(m[1]);
	}

	if (!token) throw new HTTPException(401, { message: 'No authentication token found' });

	try {
		const payload = decodeJwtPayload(token);
		if (!payload) throw new HTTPException(401, { message: 'Invalid token format' });

		// expiry check in production
		if (c.env.ENVIRONMENT === 'production') {
			if (payload.exp && typeof payload.exp === 'number') {
				const now = Math.floor(Date.now() / 1000);
				if (payload.exp < now) throw new HTTPException(401, { message: 'Token expired' });
			}
		}

		const email = String(payload.email || payload.upn || payload.sub || 'unknown');

		let roles: string[] = [];
		if (Array.isArray(payload.roles) && payload.roles.length) {
			roles = payload.roles.map(String);
		} else {
			roles = await getUserRolesFromD1(c.env as Env, email);
		}

		const user: User = {
			email,
			sub: String(payload.sub || ''),
			roles,
			raw: payload,
		};
		c.set('user', user);
		await next();
	} catch (err) {
		console.error('Authentication error', err);
		if (err instanceof HTTPException) throw err;
		throw new HTTPException(401, { message: 'Invalid authentication token' });
	}
});

// Minimal role-checking middleware factory
const requireRole = (required: string | string[]) => {
	const reqRoles = Array.isArray(required) ? required : [required];
	return createMiddleware(async (c, next) => {
		const user = c.get('user') as { roles?: string[] } | undefined;
		if (!user || !user.roles) throw new HTTPException(401, { message: 'User not authenticated' });
		const allowed = reqRoles.some((r) => (user.roles || []).includes(r));
		if (!allowed) throw new HTTPException(403, { message: `Access denied. Required: ${reqRoles.join(', ')}` });
		await next();
	});
};

// --- Routes ---
// Public health
app.get('/', (c) => c.text('File Sharing Worker Running'));

// Public listing endpoint - optional authentication so "public" users can view unrestricted files
app.get('/api/list', optionalAuthenticate, async (c) => {
	try {
		// pass caller so list can enforce `requiredRole` per-file
		const caller = c.get('user');
		const result = await handleList(c.req.raw, c.env, caller);
		return c.json(result, result.success ? 200 : 400);
	} catch (err) {
		console.error('List error', err);
		return c.json({ success: false, error: 'Internal server error' }, 500);
	}
});

// Download endpoint - optional authentication so public files can be downloaded
app.get('/api/download/:fileId', optionalAuthenticate, async (c) => {
	try {
		const fileId = c.req.param('fileId');
		const caller = c.get('user');
		return await handleDownload(c.req.raw, c.env, fileId, caller);
	} catch (err) {
		console.error('Download error', err);
		return c.text('Internal server error', 500);
	}
});

// Debug endpoint - strict auth (useful to debug cookies/headers)
app.get('/api/debug/jwt', authenticateUser, (c) => {
	try {
		let token = c.req.header('cf-access-jwt-assertion') || null;
		if (!token) {
			const cookie = c.req.header('cookie') || '';
			const m = cookie.match(/CF_Authorization=([^;]+)/);
			token = m?.[1] ? decodeURIComponent(m[1]) : null;
		}

		let jwtPayload: any = null;
		if (token) {
			try {
				jwtPayload = decodeJwtPayload(token);
			} catch (e) {
				jwtPayload = { error: 'Failed to decode JWT' };
			}
		}

		return c.json({
			success: true,
			headerPresent: !!c.req.header('cf-access-jwt-assertion'),
			cookiePresent: !!c.req.header('cookie'),
			extractedUser: c.get('user'),
			rawJwtPayload: jwtPayload,
		});
	} catch (err) {
		console.error('JWT debug error', err);
		return c.json({ success: false, error: 'Failed to parse JWT' }, 500);
	}
});

// Legacy multipart upload (admin/sme allowed; handler should enforce inside or via route-level requireRole)
app.post('/api/admin/upload', authenticateUser, async (c) => {
	try {
		const result = await handleUpload(c.req.raw, c.env);
		return c.json(result, result.success ? 200 : 400);
	} catch (err) {
		console.error('Legacy upload error', err);
		return c.json({ success: false, error: 'Internal server error' }, 500);
	}
});

// Admin-only list and cleanup
app.get('/api/admin/list', authenticateUser, requireRole('admin'), async (c) => {
	try {
		const caller = c.get('user');
		const result = await handleAdminList(c.req.raw, c.env, caller);
		return c.json(result, result.success ? 200 : 400);
	} catch (err) {
		console.error('Admin list error', err);
		return c.json({ success: false, error: 'Internal server error' }, 500);
	}
});

app.post('/api/admin/cleanup', authenticateUser, requireRole('admin'), async (c) => {
	try {
		const result = await cleanupExpiredFiles(c.env);
		return c.json(result, result.success ? 200 : 400);
	} catch (err) {
		console.error('Cleanup error', err);
		return c.json({ success: false, error: 'Internal server error', deletedCount: 0 }, 500);
	}
});

app.get('/api/admin/r2-info', authenticateUser, requireRole('admin'), (c) => {
	const accountId = c.env.R2_ACCOUNT_ID;
	const bucketName = c.env.R2_BUCKET_NAME;
	if (!accountId || !bucketName) {
		return c.json({ success: false, error: 'Missing R2 info' }, 500);
	}
	return c.json({ success: true, accountId, bucketName });
});

// --- TUS endpoints ---
// OPTIONS top-level (client capability negotiation) - allow public to probe capabilities
app.options('/api/upload/tus', async (c) => {
	try {
		const resp = await handleTusOptions(c.req.raw);
		const base = resp instanceof Response ? resp : new Response('', { status: 204 });
		base.headers.set('Tus-Resumable', '1.0.0');
		base.headers.set('Access-Control-Allow-Origin', c.req.header('Origin') || '*');
		base.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, HEAD, PATCH, DELETE');
		base.headers.set(
			'Access-Control-Allow-Headers',
			'Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Content-Type, cf-access-jwt-assertion'
		);
		return base;
	} catch (err) {
		console.error('TUS OPTIONS error', err);
		return new Response('Internal server error', { status: 500, headers: { 'Tus-Resumable': '1.0.0' } });
	}
});

// Create upload (POST) - require authentication (uploader must be identifiable)
app.post('/api/upload/tus', authenticateUser, async (c) => {
	try {
		const resp = await handleTusUploadCreation(c.req.raw, c.env);
		if (resp instanceof Response) {
			resp.headers.set('Tus-Resumable', '1.0.0');
			return resp;
		}
		const result = resp as { success?: boolean };
		return new Response(JSON.stringify(result), {
			status: result && result.success ? 201 : 400,
			headers: { 'content-type': 'application/json', 'Tus-Resumable': '1.0.0' },
		});
	} catch (err) {
		console.error('TUS creation fatal', err);
		return new Response('Internal server error', {
			status: 500,
			headers: { 'Access-Control-Allow-Origin': '*', 'Tus-Resumable': '1.0.0' },
		});
	}
});

// OPTIONS for resource - allow public
app.options('/api/upload/tus/:fileId', async (c) => {
	try {
		const resp = await handleTusOptions(c.req.raw);
		const base = resp instanceof Response ? resp : new Response('', { status: 204 });
		base.headers.set('Tus-Resumable', '1.0.0');
		base.headers.set('Access-Control-Allow-Origin', c.req.header('Origin') || '*');
		base.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, HEAD, PATCH, DELETE');
		base.headers.set(
			'Access-Control-Allow-Headers',
			'Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Content-Type, cf-access-jwt-assertion'
		);
		return base;
	} catch (err) {
		console.error('TUS OPTIONS (file) error', err);
		return new Response('Internal server error', { status: 500, headers: { 'Tus-Resumable': '1.0.0' } });
	}
});

// PATCH chunk - require auth (only uploader / authorized user should append)
app.patch('/api/upload/tus/:fileId', authenticateUser, async (c) => {
	try {
		const fileId = c.req.param('fileId');
		const resp = (await handleTusUploadChunk(c.req.raw, c.env, fileId)) as { success?: boolean } | Response;
		if (resp instanceof Response) {
			resp.headers.set('Tus-Resumable', '1.0.0');
			return resp;
		}
		const success = typeof resp === 'object' && resp !== null && 'success' in resp ? (resp as any).success : false;
		return new Response(JSON.stringify(resp), {
			status: success ? 200 : 400,
			headers: { 'content-type': 'application/json', 'Tus-Resumable': '1.0.0' },
		});
	} catch (err) {
		console.error('TUS PATCH fatal', err);
		return new Response('Internal server error', {
			status: 500,
			headers: { 'Access-Control-Allow-Origin': '*', 'Tus-Resumable': '1.0.0' },
		});
	}
});

// HEAD - require auth (uploader or authorized agent)
app.on('HEAD', '/api/upload/tus/:fileId', authenticateUser, async (c) => {
	try {
		const fileId = c.req.param('fileId');
		const resp = (await handleTusUploadHead(c.req.raw, c.env, fileId)) as { success?: boolean } | Response;
		if (resp instanceof Response) {
			resp.headers.set('Tus-Resumable', '1.0.0');
			return resp;
		}
		return new Response('', { status: resp && resp.success ? 200 : 404, headers: { 'Tus-Resumable': '1.0.0' } });
	} catch (err) {
		console.error('TUS HEAD fatal', err);
		return new Response('Internal server error', {
			status: 500,
			headers: { 'Access-Control-Allow-Origin': '*', 'Tus-Resumable': '1.0.0' },
		});
	}
});

// DELETE - require auth
app.delete('/api/upload/tus/:fileId', authenticateUser, async (c) => {
	try {
		const fileId = c.req.param('fileId');
		const resp = await handleTusUploadDelete(c.req.raw, c.env, fileId);
		if (resp instanceof Response) {
			resp.headers.set('Tus-Resumable', '1.0.0');
			return resp;
		}
		return new Response(JSON.stringify(resp), {
			status: typeof resp === 'object' && resp !== null && 'success' in resp && (resp as any).success ? 200 : 400,
			headers: { 'content-type': 'application/json', 'Tus-Resumable': '1.0.0' },
		});
	} catch (err) {
		console.error('TUS DELETE fatal', err);
		return new Response('Internal server error', {
			status: 500,
			headers: { 'Access-Control-Allow-Origin': '*', 'Tus-Resumable': '1.0.0' },
		});
	}
});

// Generic error handler
app.onError((err, c) => {
	console.error('Worker error', err);
	if (err instanceof HTTPException) {
		return c.json({ error: err.message, status: err.status }, err.status);
	}
	return c.json({ error: 'Internal server error' }, 500);
});

export default app;
