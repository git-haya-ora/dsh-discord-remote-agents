import { AppError } from './errors.js';
/** Shared value/error helpers: no HTTP transport or credential configuration. */
export function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export class DshRejected extends AppError {
}
//# sourceMappingURL=protocol.js.map