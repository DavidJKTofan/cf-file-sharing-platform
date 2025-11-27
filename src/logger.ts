/**
 * @fileoverview Structured logging utility for Cloudflare Workers.
 *
 * Provides consistent, structured logging with log levels and context.
 * In production, logs are captured by Cloudflare's observability features.
 * In development, logs are formatted for console readability.
 *
 * @module logger
 */

/** Log levels in order of severity */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log entry format */
interface LogEntry {
	/** ISO timestamp of the log entry */
	timestamp: string;
	/** Log severity level */
	level: LogLevel;
	/** Log message */
	message: string;
	/** Optional context data */
	context?: Record<string, unknown>;
	/** Optional error details */
	error?: {
		name: string;
		message: string;
		stack?: string;
	};
}

/** Logger configuration options */
interface LoggerConfig {
	/** Minimum log level to output */
	minLevel: LogLevel;
	/** Whether to include stack traces in error logs */
	includeStackTraces: boolean;
	/** Environment name for context */
	environment: 'development' | 'production';
}

/** Numeric values for log level comparison */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Creates a structured logger instance.
 *
 * @param config - Logger configuration options
 * @returns Logger instance with level-specific methods
 *
 * @example
 * ```typescript
 * const logger = createLogger({
 *   minLevel: 'info',
 *   includeStackTraces: false,
 *   environment: 'production'
 * });
 *
 * logger.info('Request received', { path: '/api/upload', method: 'POST' });
 * logger.error('Upload failed', { fileId }, error);
 * ```
 */
export function createLogger(config: LoggerConfig) {
	const shouldLog = (level: LogLevel): boolean => {
		return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[config.minLevel];
	};

	const formatEntry = (entry: LogEntry): string => {
		if (config.environment === 'development') {
			// Human-readable format for development
			const prefix = `[${entry.level.toUpperCase()}]`;
			const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
			const errorStr = entry.error ? ` Error: ${entry.error.message}` : '';
			return `${prefix} ${entry.message}${contextStr}${errorStr}`;
		}
		// JSON format for production (better for log aggregation)
		return JSON.stringify(entry);
	};

	const log = (
		level: LogLevel,
		message: string,
		context?: Record<string, unknown>,
		error?: Error
	): void => {
		if (!shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			context,
		};

		if (error) {
			entry.error = {
				name: error.name,
				message: error.message,
				...(config.includeStackTraces && { stack: error.stack }),
			};
		}

		const formatted = formatEntry(entry);

		switch (level) {
			case 'debug':
			case 'info':
				console.log(formatted);
				break;
			case 'warn':
				console.warn(formatted);
				break;
			case 'error':
				console.error(formatted);
				break;
		}
	};

	return {
		/**
		 * Log debug-level message (only in development)
		 */
		debug: (message: string, context?: Record<string, unknown>) =>
			log('debug', message, context),

		/**
		 * Log info-level message
		 */
		info: (message: string, context?: Record<string, unknown>) =>
			log('info', message, context),

		/**
		 * Log warning-level message
		 */
		warn: (message: string, context?: Record<string, unknown>, error?: Error) =>
			log('warn', message, context, error),

		/**
		 * Log error-level message
		 */
		error: (message: string, context?: Record<string, unknown>, error?: Error) =>
			log('error', message, context, error),
	};
}

/** Logger instance type */
export type Logger = ReturnType<typeof createLogger>;

/**
 * Creates a logger configured for the current environment.
 *
 * @param environment - Current environment ('development' or 'production')
 * @returns Configured logger instance
 */
export function getLogger(environment: 'development' | 'production'): Logger {
	return createLogger({
		minLevel: environment === 'development' ? 'debug' : 'info',
		includeStackTraces: environment === 'development',
		environment,
	});
}
