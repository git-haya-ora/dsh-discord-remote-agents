import { AppError } from './errors.js';
/** Shared value/error helpers: no HTTP transport or credential configuration. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export class DshRejected extends AppError {}
