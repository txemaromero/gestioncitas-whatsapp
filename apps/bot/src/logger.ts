import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured logs without PII in clear: callers log masked values (`maskPhone`, `maskEmail`),
 * and common sensitive keys are redacted as a safety net.
 */
export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'clinicai-bot' },
    redact: {
      paths: [
        'phone',
        'email',
        'text',
        'token',
        'accessToken',
        'apiKey',
        '*.phone',
        '*.email',
        '*.text',
        '*.token',
        'req.headers.authorization',
        'req.headers["x-hub-signature-256"]',
        'req.headers["x-cron-secret"]',
        'req.headers.api_access_token',
        // F34: the Chatwoot secrets and keys nested in logged objects.
        'req.headers["x-chatwoot-token"]',
        'req.headers["x-chatwoot-signature"]',
        'req.query.token',
        '*.accessToken',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
}

/** Logger that discards everything (tests, simulator). */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
