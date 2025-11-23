// src/types.ts

import type { AppConfig } from './config';

export interface JwtPayload {
	sub?: string;
	exp?: number;
	email?: string;
	roles?: string[];
	[key: string]: unknown;
}

// Types used across the worker files.
// Keep Env limited to *bindings* and config values only.
// User is a separate interface used in request context (not part of Env).

export interface Env {
	// Bindings
	R2_FILES: R2Bucket;
	FILE_METADATA?: KVNamespace;
	ROLES_DB?: D1Database;

	// Config
	config: AppConfig;

	// Secrets
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_ACCOUNT_ID?: string;
}

// User object stored in request context by auth middleware
export interface User {
	email: string;
	sub: string;
	roles: string[];
	raw: JwtPayload | { note: string }; // Raw JWT payload
}
