import { object } from './protocol.js';
export const MAX_OUTPUT = 200000;
export function redact(text, secrets) {
    let output = text;
    for (const secret of secrets)
        if (secret.length >= 4)
            output = output.split(secret).join('[REDACTED]');
    return output.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:mfa\.[A-Za-z0-9_-]{20,}))\b/g, '[REDACTED]');
}
export function assistantText(data) {
    const message = object(data.message);
    if (message.role !== 'assistant' || !Array.isArray(message.content))
        return '';
    return message.content.map(raw => object(raw)).filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n');
}
export function tail(text, limit) {
    if (text.length <= limit)
        return text;
    let part = text.slice(-(limit - 1));
    // Discord limits strings in UTF-16 units; never split a surrogate pair.
    if (/^[\uDC00-\uDFFF]/.test(part))
        part = part.slice(1);
    return `…${part}`;
}
export function boundedOutput(text) {
    return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[出力上限により省略。全文はDSHで確認してください。]` : text;
}
//# sourceMappingURL=output.js.map