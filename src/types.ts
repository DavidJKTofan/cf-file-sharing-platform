// src/types.ts

// Types used across the worker files.
// Keep Env limited to *bindings* and config values only.
// User is a separate interface used in request context (not part of Env).

export interface Env {
	// R2 bucket binding
	R2_FILES: R2Bucket;

	// KV namespace for storing file metadata and TUS progress (optional)
	FILE_METADATA?: KVNamespace;

	// Limits and environment flags (string because Wrangler env vars are strings)
	MAX_TOTAL_FILE_SIZE?: number; // in bytes
	MAX_DIRECT_UPLOAD?: string;
	ENVIRONMENT?: string;

	// Optional R2 credentials for generating signed URLs (only needed if you create signed links server-side)
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_ACCOUNT_ID?: string;
	R2_BUCKET_NAME?: string;

	// D1 user roles database
	ROLES_DB?: D1Database; // D1 binding
}

export type UserRole = 'admin' | 'sme' | 'user';

// User object stored in request context by auth middleware
export interface User {
	email: string;
	name?: string;
	groups?: string[];
	role?: UserRole;
	raw?: any; // Raw JWT payload
}
