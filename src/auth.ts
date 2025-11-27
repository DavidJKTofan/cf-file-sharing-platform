/**
 * @fileoverview Authentication and authorization middleware for Cloudflare Workers.
 *
 * Provides JWT-based authentication using Cloudflare Access tokens and
 * role-based authorization with D1 database integration.
 *
 * @module auth
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoRequest } from 'hono';
import type { Env, User, JwtPayload, UserRole } from './types';

// ============================================================================
// Constants
// ============================================================================

/** Default user for unauthenticated public access */
const PUBLIC_USER: Readonly<User> = Object.freeze({
	email: 'public',
	sub: 'public',
	roles: ['public'],
	raw: { note: 'Unauthenticated public user' },
});

/** Default roles when no roles are found in JWT or D1 */
const DEFAULT_USER_ROLES: readonly UserRole[] = ['user'];

/** Default roles for development mock user */
const DEFAULT_DEV_ROLES: readonly UserRole[] = ['admin', 'sme', 'user'];

// ============================================================================
// JWT Utilities
// ============================================================================

/**
 * Decodes and parses a JWT payload without verification.
 *
 * @remarks
 * This function only decodes the payload - signature verification is handled
 * by Cloudflare Access. For custom JWTs, implement proper verification.
 *
 * @param token - JWT token string
 * @returns Parsed payload or null if decoding fails
 */
function decodeJwtPayload(token: string): JwtPayload | null {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) {
			return null;
		}

		// Convert base64url to base64 and add padding
		const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const paddingNeeded = payloadB64.length % 4;
		const paddedPayload = paddingNeeded
			? payloadB64 + '='.repeat(4 - paddingNeeded)
			: payloadB64;

		const decoded = atob(paddedPayload);
		return JSON.parse(decoded) as JwtPayload;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		console.error('[AUTH] Failed to decode JWT payload:', { error: errorMessage });
		return null;
	}
}

/**
 * Extracts JWT token from request headers or cookies.
 *
 * @remarks
 * Checks in order:
 * 1. `cf-access-jwt-assertion` header (Cloudflare Access)
 * 2. `CF_Authorization` cookie (Cloudflare Access fallback)
 *
 * @param req - Hono request object
 * @returns JWT token string or null if not found
 */
function extractJwtFromRequest(req: HonoRequest): string | null {
	// Check Cloudflare Access header first
	const headerToken = req.header('cf-access-jwt-assertion');
	if (headerToken) {
		return headerToken;
	}

	// Fall back to cookie
	const cookieHeader = req.header('cookie') ?? '';
	const match = cookieHeader.match(/CF_Authorization=([^;]+)/);
	if (match?.[1]) {
		return decodeURIComponent(match[1]);
	}

	return null;
}

/**
 * Checks if a JWT token has expired.
 *
 * @param payload - Decoded JWT payload
 * @returns True if token is expired
 */
function isTokenExpired(payload: JwtPayload): boolean {
	if (!payload.exp) {
		return false;
	}
	const nowSeconds = Math.floor(Date.now() / 1000);
	return payload.exp < nowSeconds;
}

// ============================================================================
// Role Management
// ============================================================================

/**
 * Parses roles from various storage formats.
 *
 * @remarks
 * Roles can be stored as:
 * - JSON array: `["admin", "user"]`
 * - Comma-separated string: `"admin, user"`
 *
 * @param roles - Raw roles value from database
 * @returns Array of role strings
 */
function parseRoles(roles: string | string[]): UserRole[] {
	if (Array.isArray(roles)) {
		return roles.map(String);
	}

	if (typeof roles === 'string') {
		// Try JSON parse first
		try {
			const parsed = JSON.parse(roles);
			if (Array.isArray(parsed)) {
				return parsed.map(String);
			}
		} catch {
			// Fall through to comma-separated parsing
		}

		// Parse as comma-separated
		return roles
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	return [...DEFAULT_USER_ROLES];
}

/**
 * Fetches user roles from D1 database.
 *
 * @param env - Environment with D1 binding
 * @param email - User's email address
 * @returns Array of user roles, defaults to ['user'] on failure
 */
async function getUserRolesFromD1(env: Env, email: string): Promise<UserRole[]> {
	if (!env.ROLES_DB || !email) {
		return [...DEFAULT_USER_ROLES];
	}

	try {
		const stmt = env.ROLES_DB.prepare(
			'SELECT roles FROM user_roles WHERE email = ?1 LIMIT 1'
		);
		const row = await stmt.bind(email).first<{ roles: string | string[] }>();

		if (!row?.roles) {
			return [...DEFAULT_USER_ROLES];
		}

		return parseRoles(row.roles);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		console.warn('[AUTH] D1 role lookup failed:', { email, error: errorMessage });
		return [...DEFAULT_USER_ROLES];
	}
}

// ============================================================================
// Authentication Middleware
// ============================================================================

/** Options for the authenticate middleware */
interface AuthenticateOptions {
	/** If true, allows unauthenticated requests with PUBLIC_USER */
	optional: boolean;
}

/**
 * Creates authentication middleware for Hono routes.
 *
 * @remarks
 * In development with DEV_USER_EMAIL set, authentication is bypassed.
 * In production, validates Cloudflare Access JWT tokens.
 *
 * @param options - Authentication options
 * @returns Hono middleware function
 *
 * @example
 * ```typescript
 * // Required authentication
 * app.use('/api/admin/*', authenticate({ optional: false }));
 *
 * // Optional authentication (public routes)
 * app.use('/api/public/*', authenticate({ optional: true }));
 * ```
 */
export const authenticate = (options: AuthenticateOptions) => {
	return createMiddleware<{ Bindings: Env; Variables: { user: User } }>(async (c, next) => {
		const { config, ROLES_DB, logger } = c.env;
		const isDev = config.ENVIRONMENT === 'development';

		// Development bypass: Use mock user if DEV_USER_EMAIL is configured
		if (isDev && config.DEV_USER_EMAIL) {
			const roles = config.DEV_USER_ROLES
				? config.DEV_USER_ROLES.split(',').map((s) => s.trim())
				: [...DEFAULT_DEV_ROLES];

			const devUser: User = {
				email: config.DEV_USER_EMAIL,
				sub: 'dev-user',
				roles,
				raw: { note: 'Development mock user - authentication bypassed' },
			};

			logger.debug('Using development mock user', { email: devUser.email, roles });
			c.set('user', devUser);
			return next();
		}

		// Extract JWT from request
		const token = extractJwtFromRequest(c.req);
		if (!token) {
			if (options.optional) {
				c.set('user', { ...PUBLIC_USER });
				return next();
			}

			logger.warn('Authentication token not found', { path: c.req.path });

			const message = isDev
				? 'Authentication token not found. Set DEV_USER_EMAIL in .dev.vars to bypass.'
				: 'Authentication token not found';
			throw new HTTPException(401, { message });
		}

		// Decode JWT payload
		const payload = decodeJwtPayload(token);
		if (!payload) {
			if (options.optional) {
				c.set('user', { ...PUBLIC_USER });
				return next();
			}
			throw new HTTPException(401, { message: 'Invalid token format' });
		}

		// Check token expiration (production only - dev tokens may be stale)
		if (!isDev && isTokenExpired(payload)) {
			if (options.optional) {
				c.set('user', { ...PUBLIC_USER });
				return next();
			}
			logger.warn('Token expired', { sub: payload.sub, exp: payload.exp });
			throw new HTTPException(401, { message: 'Token has expired' });
		}

		// Extract user identity
		const email = String(payload.email ?? payload.upn ?? payload.sub ?? 'unknown');
		const sub = String(payload.sub ?? '');

		// Get roles from JWT or D1
		const roles: UserRole[] =
			Array.isArray(payload.roles) && payload.roles.length > 0
				? payload.roles.map(String)
				: await getUserRolesFromD1({ ROLES_DB } as Env, email);

		const user: User = { email, sub, roles, raw: payload };
		logger.debug('User authenticated', { email, roles });
		c.set('user', user);

		return next();
	});
};

// ============================================================================
// Authorization Middleware
// ============================================================================

/**
 * Creates role-based authorization middleware.
 *
 * @remarks
 * Must be used after `authenticate()` middleware. Checks if the authenticated
 * user has at least one of the required roles.
 *
 * @param required - Single role or array of roles (user needs at least one)
 * @returns Hono middleware function
 *
 * @example
 * ```typescript
 * // Single role required
 * app.post('/admin/upload', requireRole('admin'), handleUpload);
 *
 * // Multiple roles (OR logic)
 * app.post('/upload', requireRole(['admin', 'sme']), handleUpload);
 * ```
 */
export const requireRole = (required: UserRole | UserRole[]) => {
	const requiredRoles = Array.isArray(required) ? required : [required];

	return createMiddleware<{ Bindings: Env; Variables: { user: User } }>(async (c, next) => {
		const user = c.get('user');
		const { logger } = c.env;

		// Check if user exists and has required role
		const hasRequiredRole = user?.roles.some((role) => requiredRoles.includes(role));

		if (!user || !hasRequiredRole) {
			logger.warn('Access denied - insufficient role', {
				userEmail: user?.email ?? 'unknown',
				userRoles: user?.roles ?? [],
				requiredRoles,
				path: c.req.path,
			});

			throw new HTTPException(403, {
				message: `Access denied. Required role: ${requiredRoles.join(' or ')}`,
			});
		}

		return next();
	});
};

/**
 * Checks if a user has admin privileges.
 *
 * @param user - User object to check
 * @returns True if user has admin role
 */
export function isAdmin(user: User | undefined): boolean {
	return user?.roles.includes('admin') ?? false;
}

/**
 * Checks if a user has a specific role.
 *
 * @param user - User object to check
 * @param role - Role to check for
 * @returns True if user has the specified role
 */
export function hasRole(user: User | undefined, role: UserRole): boolean {
	return user?.roles.includes(role) ?? false;
}
