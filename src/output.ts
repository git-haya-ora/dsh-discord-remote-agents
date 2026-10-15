import { createHash } from 'node:crypto';
import { object } from './protocol.js';
export const MAX_OUTPUT = 200000;
export const MAX_FINAL_CODEPOINTS = 100000;
export const MAX_FINAL_PARTS = 128;
export function digest(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) if (secret.length >= 4) output = output.split(secret).join('[REDACTED]');
  return output.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:mfa\.[A-Za-z0-9_-]{20,}))\b/g, '[REDACTED]');
}
export function assistantText(data: Record<string, unknown>): string {
  const message = object(data.message);
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content.map(raw => object(raw)).filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string).join('\n');
}
export function finalAssistantText(data: Record<string, unknown>): string | undefined {
  const message = object(data.message);
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  // An assistant tool invocation is not a final answer, even if it includes text.
  if (message.content.some(raw => ['tool_use', 'tool_call', 'tool_result'].includes(String(object(raw).type)))) return undefined;
  return assistantText(data);
}
export function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let part = text.slice(-(limit - 1));
  if (/^[\uDC00-\uDFFF]/.test(part)) part = part.slice(1);
  return `…${part}`;
}
export function boundedOutput(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[出力上限により省略。全文はDSHで確認してください。]` : text;
}
export interface TextPart { body: string; content: string; prefix: string; suffix: string }
export interface TextPlan { parts: TextPart[]; complete: boolean; codepoints: number; digest: string }
const capNotice = '\n全文配信未完了: 上限100,000 Unicode code points / 128 parts。全文はPCの同一DSH Sessionで確認してください。';
/** Body slices are exact; display-only fence closures/reopeners are separately recorded. */
export function splitFinalOutput(text: string, runId: string, capped = true): TextPlan {
  if (runId.length > 256 || /[\r\n]/u.test(runId)) throw new Error('INVALID_RUN_ID');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error('MALFORMED_OUTPUT_UNICODE');
  const points = Array.from(text);
  const source = capped ? points.slice(0, MAX_FINAL_CODEPOINTS).join('') : text;
  const parts: TextPart[] = [];
  let offset = 0; let fence = ''; let lineStart = true; let partialLine = '';
  // Reserve a conservative header and notice budget before partitioning. Each
  // codepoint is copied once; no trim, normalization or surrogate splitting.
  const headerReserve = `Run ${runId} | part 128/128\n`.length;
  do {
    const prefix = fence ? `${fence}\n` : '';
    const budget = 2000 - headerReserve - prefix.length - 100 - capNotice.length;
    let end = offset;
    for (const point of source.slice(offset)) { if (end - offset + point.length > budget) break; end += point.length; }
    const body = source.slice(offset, end);
    for (const char of body) {
      if (lineStart) partialLine += char;
      if (char === '\n') {
        const match = /^(\s{0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n$/u.exec(partialLine);
        if (match) {
          const marker = match[2]!;
          // Oversized markers cannot be safely displayed within Discord's
          // limit: omit display-only repair, never omit the original body.
          if (!fence && marker.length <= 40) fence = marker + Array.from(match[3]!.replace(/\r$/u, '')).slice(0, 40).join('');
          else if (marker[0] === fence[0] && marker.length >= (/^[`~]+/u.exec(fence)?.[0].length ?? 3) && !match[3]!.trim()) fence = '';
        }
        partialLine = ''; lineStart = true;
      }
    }
    const marker = /^[`~]+/u.exec(fence)?.[0] ?? '';
    const suffix = fence ? `\n${marker}` : '';
    parts.push({ body, prefix, suffix, content: '' }); offset = end;
    if (capped && parts.length >= MAX_FINAL_PARTS) break;
  } while (offset < source.length);
  const complete = offset === text.length && (!capped || points.length <= MAX_FINAL_CODEPOINTS);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    part.content = `Run ${runId} | part ${i + 1}/${parts.length}\n${part.prefix}${part.body}${part.suffix}${!complete && i === parts.length - 1 ? capNotice : ''}`;
    if (part.content.length > 2000) throw new Error('PART_LIMIT');
  }
  if (parts.map(part => part.body).join('') !== text.slice(0, offset)) throw new Error('PART_RECONSTRUCTION');
  return { parts, complete, codepoints: points.length, digest: digest(text) };
}
