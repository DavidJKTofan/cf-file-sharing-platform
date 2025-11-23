// src/config.ts
import { z } from 'zod';

const configSchema = z.object({
	APP_URL: z.string().url(),
	ENVIRONMENT: z.enum(['development', 'production']),
	MAX_DIRECT_UPLOAD: z.coerce.number().int().positive(),
	MAX_TOTAL_FILE_SIZE: z.coerce.number().int().positive(),
	R2_BUCKET_NAME: z.string(),
	R2_ACCOUNT_ID: z.string(),
	DEV_USER_EMAIL: z.preprocess((v) => v || undefined, z.string().email().optional()),
	DEV_USER_ROLES: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function defineConfig(env: Record<string, unknown>): AppConfig {
	const parsed = configSchema.safeParse(env);

	if (!parsed.success) {
		console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
		throw new Error('Invalid environment variables.');
	}

	return parsed.data;
}
