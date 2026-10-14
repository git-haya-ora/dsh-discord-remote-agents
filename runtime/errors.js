export class AppError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export const failure = (code, message) => { throw new AppError(code, message); };
export function safeError(error) {
    return error instanceof AppError ? `[${error.code}] ${error.message}` : '[INTERNAL_ERROR] 処理に失敗しました。設定と接続状態を確認してください。';
}
export function errorCode(error) {
    return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}
//# sourceMappingURL=errors.js.map