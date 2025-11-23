// src/auth.ts
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoRequest } from 'hono';
import type { Env, User, JwtPayload } from './types';

const PUBLIC_USER: User = { email: 'public', sub: 'public', roles: ['public'], raw: { note: 'Public user' } };

function decodeJwtPayload(token: string): JwtPayload | null {
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

export const authenticate = (options: { optional: boolean }) => {
	return createMiddleware<{ Bindings: Env; Variables: { user: User } }>(async (c, next) => {
		const { config, ROLES_DB } = c.env;
		console.log('[DEBUG] Auth middleware config:', JSON.stringify(config, null, 2));

		if (config.ENVIRONMENT === 'development' && config.DEV_USER_EMAIL) {
			const roles = config.DEV_USER_ROLES ? config.DEV_USER_ROLES.split(',').map((s: string) => s.trim()) : ['admin', 'sme', 'user'];
			c.set('user', {
				email: config.DEV_USER_EMAIL,
				sub: 'dev-user',
				roles,
				raw: { note: 'This is a mock user for development. Authentication is bypassed.' },
			});
			return await next();
		}

		const token = getJwt(c.req);
		if (!token) {
			if (options.optional) {
				c.set('user', PUBLIC_USER);
				return await next();
			}
			if (config.ENVIRONMENT !== 'production') {
				throw new HTTPException(401, {
					message:
						'Authentication token not found. In development, you can bypass this by setting DEV_USER_EMAIL and optionally DEV_USER_ROLES in your .dev.vars file.',
				});
			}
			throw new HTTPException(401, { message: 'Authentication token not found' });
		}

		const payload = decodeJwtPayload(token);
		if (!payload) {
			if (options.optional) {
				c.set('user', PUBLIC_USER);
				return await next();
			}
			throw new HTTPException(401, { message: 'Invalid token format' });
		}

		if (config.ENVIRONMENT === 'production' && payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
			if (options.optional) {
				c.set('user', PUBLIC_USER);
				return await next();
			}
			throw new HTTPException(401, { message: 'Token has expired' });
		}

		const email = String(payload.email || payload.upn || payload.sub || 'unknown');
		const roles =
			Array.isArray(payload.roles) && payload.roles.length > 0
				? payload.roles.map(String)
				: await getUserRolesFromD1({ ROLES_DB } as Env, email);

		c.set('user', { email, sub: String(payload.sub || ''), roles, raw: payload });
		await next();
	});
};

export const requireRole = (required: string | string[]) => {
	const requiredRoles = Array.isArray(required) ? required : [required];
	return createMiddleware<{ Bindings: Env; Variables: { user: User } }>(async (c, next) => {
		const user = c.get('user');
		if (!user || !user.roles.some((role: string) => requiredRoles.includes(role))) {
			throw new HTTPException(403, { message: `Access denied. Required role: ${requiredRoles.join(' or ')}` });
		}
		await next();
	});
};
