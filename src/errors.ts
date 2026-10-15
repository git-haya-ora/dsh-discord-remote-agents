export class AppError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export const failure = (code: string, message: string): never => { throw new AppError(code, message); };
export function safeError(error: unknown): string {
  return error instanceof AppError ? `[${error.code}] ${error.message}` : '[INTERNAL_ERROR] 処理に失敗しました。設定と接続状態を確認してください。';
}
export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}
