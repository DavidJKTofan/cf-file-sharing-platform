/**
 * @fileoverview Core type definitions for the File Sharing Platform.
 *
 * This module contains all shared TypeScript interfaces and types used
 * across the Cloudflare Worker application. Types are organized into:
 * - JWT/Authentication types
 * - Environment bindings (Cloudflare resources)
 * - User context types
 * - File metadata types
 *
 * @module types
 */

import type { AppConfig } from './config';
import type { Logger } from './logger';
import type { TusUploadHandler } from './durable/TusUploadHandler';

// ============================================================================
// Authentication Types
// ============================================================================

/**
 * JWT payload structure from Cloudflare Access or custom tokens.
 *
 * @remarks
 * The payload may contain additional claims depending on the identity provider.
 * Common additional fields include `upn` (User Principal Name) from Azure AD.
 */
export interface JwtPayload {
	/** Subject identifier (unique user ID) */
	sub?: string;
	/** Token expiration timestamp (Unix epoch seconds) */
	exp?: number;
	/** User's email address */
	email?: string;
	/** User Principal Name (Azure AD) */
	upn?: string;
	/** User's assigned roles */
	roles?: string[];
	/** Allow additional claims from identity providers */
	[key: string]: unknown;
}

// ============================================================================
// Environment & Bindings Types
// ============================================================================

/**
 * Cloudflare Worker environment bindings and configuration.
 *
 * @remarks
 * This interface defines all resources bound to the Worker:
 * - R2 bucket for file storage
 * - KV namespace for metadata caching
 * - D1 database for user roles
 * - Runtime configuration
 * - Secrets for R2 API access
 *
 * @see {@link https://developers.cloudflare.com/workers/runtime-apis/bindings/}
 */
export interface Env {
	// -------------------------------------------------------------------------
	// Cloudflare Bindings
	// -------------------------------------------------------------------------

	/** R2 bucket for file storage */
	R2_FILES: R2Bucket;

	/** KV namespace for file metadata caching (optional) */
	FILE_METADATA?: KVNamespace;

	/** D1 database for user role management (optional) */
	ROLES_DB?: D1Database;

	/** Durable Object namespace for TUS upload handling */
	TUS_UPLOAD_HANDLER: DurableObjectNamespace<TusUploadHandler>;

	// -------------------------------------------------------------------------
	// Runtime Configuration
	// -------------------------------------------------------------------------

	/** Parsed and validated application configuration */
	config: AppConfig;

	/** Logger instance for structured logging */
	logger: Logger;

	// -------------------------------------------------------------------------
	// Secrets (set via wrangler secret or .dev.vars)
	// -------------------------------------------------------------------------

	/** R2 API access key ID for presigned URLs */
	R2_ACCESS_KEY_ID?: string;

	/** R2 API secret access key for presigned URLs */
	R2_SECRET_ACCESS_KEY?: string;

	/** Cloudflare account ID for R2 API endpoint */
	R2_ACCOUNT_ID?: string;
}

// ============================================================================
// User Context Types
// ============================================================================

/** User role identifiers */
export type UserRole = 'admin' | 'sme' | 'user' | 'public' | string;

/**
 * Authenticated user context stored in request variables.
 *
 * @remarks
 * This object is populated by the authentication middleware and
 * made available to route handlers via `c.get('user')`.
 */
export interface User {
	/** User's email address */
	email: string;

	/** Subject identifier from JWT */
	sub: string;

	/** User's assigned roles for authorization */
	roles: UserRole[];

	/** Raw JWT payload or mock user note (for debugging) */
	raw: JwtPayload | { note: string };
}

// ============================================================================
// File Metadata Types
// ============================================================================

/**
 * Custom metadata stored with R2 objects.
 *
 * @remarks
 * This metadata is stored in R2's customMetadata field and optionally
 * cached in KV for faster access during list operations.
 */
export interface FileCustomMetadata {
	/** Unique file identifier (UUID) */
	fileId: string;

	/** User-provided file description */
	description: string;

	/** Comma-separated tags for categorization */
	tags: string;

	/** ISO 8601 expiration date (empty if no expiration) */
	expiration: string;

	/** File checksum for integrity verification */
	checksum: string;

	/** Original filename as uploaded */
	originalName: string;

	/** ISO 8601 upload timestamp */
	uploadedAt: string;

	/** Whether file is hidden from public listings */
	hideFromList: string;

	/** Role required to access this file (empty for public) */
	requiredRole: string;

	/** Upload method: 'multipart' or 'tus' */
	uploadType: 'multipart' | 'tus' | string;

	// -------------------------------------------------------------------------
	// Request Context (captured at upload time)
	// -------------------------------------------------------------------------

	/** Autonomous System Number of uploader */
	asn: string;

	/** Country code of uploader */
	country: string;

	/** City of uploader */
	city: string;

	/** Timezone of uploader */
	timezone: string;

	/** User-Agent header of uploader */
	userAgent: string;
}

/**
 * File list item returned by list endpoints.
 */
export interface FileListItem {
	/** Unique file identifier */
	fileId: string;

	/** Display filename */
	filename: string;

	/** File description */
	description?: string;

	/** File tags */
	tags?: string;

	/** Expiration date (ISO 8601) */
	expiration?: string;

	/** File checksum */
	checksum?: string;

	/** Upload timestamp (ISO 8601) */
	uploadedAt: string;

	/** File size in bytes */
	size: number;

	/** MIME content type */
	contentType?: string;

	/** Upload method used */
	uploadType?: string;

	/** Download URL path */
	downloadUrl: string;

	/** Whether file has expired */
	isExpired: boolean;

	/** Whether file is hidden from public listings */
	hideFromList: boolean;

	/** Required role for access (null if public) */
	requiredRole: string | null;
}

// ============================================================================
// API Response Types
// ============================================================================

/** Base API response structure */
export interface ApiResponse<T = unknown> {
	/** Whether the request was successful */
	success: boolean;

	/** Response data (on success) */
	data?: T;

	/** Error message (on failure) */
	error?: string;

	/** Validation issues (on validation failure) */
	issues?: Record<string, string[]>;
}

/** Upload response data */
export interface UploadResponseData {
	fileId: string;
	filename: string;
	downloadUrl: string;
}

/** List response data */
export interface ListResponseData {
	files: FileListItem[];
	stats?: {
		totalFiles: number;
		totalSize: number;
		averageSize: number;
		largestFileSize: number;
		expiredFiles: number;
		hiddenFiles: number;
		publicFiles: number;
	};
}

// ============================================================================
// Cloudflare Request Context Types
// ============================================================================

/**
 * Cloudflare-specific request properties.
 *
 * @see {@link https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties}
 */
export interface CfProperties {
	/** Autonomous System Number */
	asn?: number;
	/** Country code (ISO 3166-1 alpha-2) */
	country?: string;
	/** City name */
	city?: string;
	/** Timezone identifier */
	timezone?: string;
	/** Continent code */
	continent?: string;
	/** Region/state code */
	region?: string;
	/** Postal code */
	postalCode?: string;
	/** Latitude */
	latitude?: string;
	/** Longitude */
	longitude?: string;
}
