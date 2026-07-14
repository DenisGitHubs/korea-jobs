// collector/src/log.ts
//
// Minimal logger. IMPORTANT (007): never log message text or phone numbers in
// plaintext. Log structural facts (chat id, message id, counts) only.

import { config } from './config.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function enabled(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf((config.logLevel as Level) ?? 'info');
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(`[collector] ${level}: ${line}`);
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
};
