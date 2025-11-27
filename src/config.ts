/**
 * @fileoverview Application configuration with Zod validation.
 *
 * Provides type-safe configuration parsing and validation for environment
 * variables. All configuration is validated at Worker startup to fail fast
 * on misconfiguration.
 *
 * @module config
 */

import { z } from 'zod';

// ============================================================================
// Configuration Schema
// ============================================================================

/**
 * Zod schema for application configuration.
 *
 * @remarks
 * All environment variables are validated and coerced to appropriate types.
 * Required variables will cause startup failure if missing or invalid.
 */
const configSchema = z.object({
	/** Base URL for the application (used for generating download URLs) */
	APP_URL: z.string().url({ message: 'APP_URL must be a valid URL' }),

	/** Current environment - affects logging, auth bypass, and download method */
	ENVIRONMENT: z.enum(['development', 'production'], {
		message: 'ENVIRONMENT must be "development" or "production"',
	}),

	/** Maximum file size for direct (non-TUS) uploads in bytes */
	MAX_DIRECT_UPLOAD: z.coerce
		.number()
		.int()
		.positive({ message: 'MAX_DIRECT_UPLOAD must be a positive integer' }),

	/** Maximum total file size allowed (including TUS uploads) in bytes */
	MAX_TOTAL_FILE_SIZE: z.coerce
		.number()
		.int()
		.positive({ message: 'MAX_TOTAL_FILE_SIZE must be a positive integer' }),

	/** R2 bucket name for file storage */
	R2_BUCKET_NAME: z.string().min(1, { message: 'R2_BUCKET_NAME is required' }),

	/** Cloudflare account ID for R2 API access */
	R2_ACCOUNT_ID: z.string().min(1, { message: 'R2_ACCOUNT_ID is required' }),

	/** Development-only: Email for mock user (bypasses authentication) */
	DEV_USER_EMAIL: z.preprocess(
		(v) => (v === '' ? undefined : v),
		z.string().email({ message: 'DEV_USER_EMAIL must be a valid email' }).optional()
	),

	/** Development-only: Comma-separated roles for mock user */
	DEV_USER_ROLES: z.string().optional(),
});

/** Inferred TypeScript type from the config schema */
export type AppConfig = z.infer<typeof configSchema>;

// ============================================================================
// Configuration Helpers
// ============================================================================

/**
 * Formats configuration validation errors for logging.
 *
 * @param errors - Flattened Zod field errors
 * @returns Formatted error string
 */
function formatConfigErrors(errors: Record<string, string[] | undefined>): string {
	const lines: string[] = [];
	for (const [field, messages] of Object.entries(errors)) {
		if (messages && messages.length > 0) {
			lines.push(`  - ${field}: ${messages.join(', ')}`);
		}
	}
	return lines.join('\n');
}

// ============================================================================
// Configuration Factory
// ============================================================================

/**
 * Parses and validates environment variables into typed configuration.
 *
 * @param env - Raw environment variables from Worker binding
 * @returns Validated and typed configuration object
 * @throws {Error} If any required configuration is missing or invalid
 *
 * @example
 * ```typescript
 * // In middleware
 * const config = defineConfig(c.env);
 * console.log(config.ENVIRONMENT); // 'development' | 'production'
 * ```
 */
export function defineConfig(env: Record<string, unknown>): AppConfig {
	const parsed = configSchema.safeParse(env);

	if (!parsed.success) {
		const fieldErrors = parsed.error.flatten().fieldErrors;
		const errorMessage = formatConfigErrors(fieldErrors);

		// Log detailed errors for debugging
		console.error('[CONFIG] Invalid environment configuration:');
		console.error(errorMessage);

		// Throw with summary for error response
		throw new Error(
			`Invalid environment configuration. Check the following fields:\n${errorMessage}`
		);
	}

	// Log successful configuration in development (without sensitive data)
	if (parsed.data.ENVIRONMENT === 'development') {
		console.log('[CONFIG] Configuration loaded successfully:', {
			ENVIRONMENT: parsed.data.ENVIRONMENT,
			APP_URL: parsed.data.APP_URL,
			MAX_DIRECT_UPLOAD: `${(parsed.data.MAX_DIRECT_UPLOAD / 1024 / 1024).toFixed(0)}MB`,
			MAX_TOTAL_FILE_SIZE: `${(parsed.data.MAX_TOTAL_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB`,
			R2_BUCKET_NAME: parsed.data.R2_BUCKET_NAME,
			DEV_USER_EMAIL: parsed.data.DEV_USER_EMAIL ? '(set)' : '(not set)',
		});
	}

	return parsed.data;
}

/**
 * Validates that required secrets are present for production features.
 *
 * @param env - Environment object with potential secrets
 * @returns Object indicating which features are available
 */
export function validateSecrets(env: {
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
}): { presignedUrlsAvailable: boolean } {
	const hasR2Credentials = Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);

	return {
		presignedUrlsAvailable: hasR2Credentials,
	};
}
