/**
 * @fileoverview Main entry point for the File Sharing Platform Cloudflare Worker.
 *
 * This module sets up the Hono application with:
 * - Configuration and logging middleware
 * - CORS and security headers
 * - Public and authenticated API routes
 * - TUS resumable upload protocol support
 * - Centralized error handling
 *
 * @module index
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Env, User } from './types';
import { defineConfig } from './config';
import { getLogger } from './logger';
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

// Re-export Durable Object class for Wrangler
export { TusUploadHandler } from './durable/TusUploadHandler';

// ============================================================================
// Application Setup
// ============================================================================

/** Hono application with typed bindings and variables */
const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// ============================================================================
// Core Middleware
// ============================================================================

/**
 * Configuration middleware - initializes config and logger on first request.
 *
 * @remarks
 * This runs before all other middleware to ensure config and logger
 * are available throughout the request lifecycle.
 */
const initMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	// Initialize config if not already set
	if (!c.env.config) {
		c.env.config = defineConfig(c.env as unknown as Record<string, unknown>);
	}

	// Initialize logger if not already set
	if (!c.env.logger) {
		c.env.logger = getLogger(c.env.config.ENVIRONMENT);
	}

	return next();
});

app.use('*', initMiddleware);

/**
 * CORS middleware - configures Cross-Origin Resource Sharing.
 *
 * @remarks
 * - Production: Restricts to APP_URL origin only
 * - Development: Allows all origins for easier testing
 */
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
			// TUS protocol headers
			'Tus-Resumable',
			'Upload-Length',
			'Upload-Metadata',
			'Upload-Offset',
		],
		exposeHeaders: ['Location', 'Tus-Resumable', 'Upload-Offset'],
	});

	return corsMiddleware(c, next);
});

/**
 * Security headers middleware - adds security-related HTTP headers.
 *
 * @remarks
 * Applied after route handlers to ensure headers are set on all responses.
 * Headers follow OWASP security best practices.
 *
 * @see {@link https://owasp.org/www-project-secure-headers/}
 */
const SECURITY_HEADERS: Record<string, string> = {
	// Prevent clickjacking
	'X-Frame-Options': 'DENY',
	// Prevent MIME type sniffing
	'X-Content-Type-Options': 'nosniff',
	// Control referrer information
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	// Enforce HTTPS (1 year with preload)
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
	// Content Security Policy
	'Content-Security-Policy': [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
		'upgrade-insecure-requests',
	].join('; '),
	// Disable unnecessary browser features
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

app.use('*', async (c, next) => {
	await next();

	// Apply security headers to response
	for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
		c.header(header, value);
	}
});

// ============================================================================
// Health Check Route
// ============================================================================

/** Health check endpoint for monitoring */
app.get('/', (c) => {
	return c.json({
		status: 'healthy',
		service: 'file-sharing-platform',
		timestamp: new Date().toISOString(),
	});
});

// ============================================================================
// Public API Routes (optional authentication)
// ============================================================================

const publicApi = new Hono<{ Bindings: Env; Variables: { user?: User } }>();

// Apply optional authentication - allows public access but extracts user if authenticated
publicApi.use('*', authenticate({ optional: true }));

/** List publicly available files */
publicApi.get('/list', (c) => handleList(c));

/** Download a file by ID */
publicApi.get('/download/:fileId', (c) => handleDownload(c));

// ============================================================================
// Authenticated API Routes (required authentication)
// ============================================================================

const authApi = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Apply required authentication
authApi.use('*', authenticate({ optional: false }));

/**
 * Debug endpoint - returns current user's JWT information.
 * Useful for troubleshooting authentication issues.
 */
authApi.get('/debug/jwt', (c) => {
	const user = c.get('user');
	return c.json({
		success: true,
		extractedUser: {
			email: user.email,
			sub: user.sub,
			roles: user.roles,
		},
		rawJwtPayload: user.raw,
	});
});

// ============================================================================
// Admin Routes (requires admin or sme role)
// ============================================================================

/** Upload a file (admin/sme only) */
authApi.post('/admin/upload', requireRole(['admin', 'sme']), (c) => handleUpload(c));

/** List all files with admin stats (admin only) */
authApi.get('/admin/list', requireRole('admin'), (c) => handleAdminList(c));

/** Cleanup expired files (admin only) */
authApi.post('/admin/cleanup', requireRole('admin'), (c) => cleanupExpiredFiles(c));

/** Get R2 bucket information (admin only) */
authApi.get('/admin/r2-info', requireRole('admin'), (c) => {
	const { R2_ACCOUNT_ID: accountId } = c.env;
	const { R2_BUCKET_NAME: bucketName } = c.env.config;

	if (!accountId || !bucketName) {
		c.env.logger.error('R2 configuration missing', { accountId: !!accountId, bucketName: !!bucketName });
		throw new HTTPException(500, { message: 'R2 configuration is missing' });
	}

	return c.json({ success: true, accountId, bucketName });
});

// ============================================================================
// TUS Resumable Upload Routes
// ============================================================================

/** TUS: Create new upload session */
authApi.post('/upload/tus', requireRole(['admin', 'sme']), (c) => handleTusUploadCreation(c));

/** TUS: Upload chunk */
authApi.patch('/upload/tus/:fileId', requireRole(['admin', 'sme']), (c) => handleTusUploadChunk(c));

/** TUS: Get upload status */
authApi.on('HEAD', '/upload/tus/:fileId', requireRole(['admin', 'sme']), (c) => handleTusUploadHead(c));

/** TUS: Cancel/delete upload */
authApi.delete('/upload/tus/:fileId', requireRole(['admin', 'sme']), (c) => handleTusUploadDelete(c));

// TUS OPTIONS handlers (no auth required for CORS preflight)
app.options('/api/upload/tus', handleTusOptions);
app.options('/api/upload/tus/:fileId', handleTusOptions);

// ============================================================================
// Mount API Routes
// ============================================================================

app.route('/api', publicApi);
app.route('/api', authApi);

// ============================================================================
// Error Handler
// ============================================================================

/**
 * Global error handler - converts all errors to JSON responses.
 *
 * @remarks
 * Handles:
 * - Zod validation errors (400)
 * - HTTP exceptions (various status codes)
 * - Unexpected errors (500)
 *
 * Server errors (5xx) are logged for debugging.
 */
app.onError((err, c) => {
	const logger = c.env.logger;

	// Handle Zod validation errors
	if (err instanceof z.ZodError) {
		logger?.debug('Validation error', { issues: err.flatten().fieldErrors });
		return c.json(
			{
				success: false,
				error: 'Invalid input',
				issues: err.flatten().fieldErrors,
			},
			400
		);
	}

	// Handle HTTP exceptions
	if (err instanceof HTTPException) {
		// Log server errors (5xx) for debugging
		if (err.status >= 500) {
			logger?.error('Server error', { status: err.status, message: err.message }, err);
		}

		return c.json(
			{
				success: false,
				error: err.message || 'An error occurred',
			},
			err.status
		);
	}

	// Handle unexpected errors
	const errorMessage = err instanceof Error ? err.message : 'Unknown error';
	logger?.error('Unhandled error', { message: errorMessage }, err instanceof Error ? err : undefined);

	return c.json(
		{
			success: false,
			error: 'Internal Server Error',
		},
		500
	);
});

// ============================================================================
// Export
// ============================================================================

export default app;
