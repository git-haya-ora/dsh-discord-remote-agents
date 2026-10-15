import { DshAdapter } from './dsh.js';
import { safeError } from './errors.js';
async function check(): Promise<void> {
  const adapter = new DshAdapter(process.env.DSH_URL ?? 'http://127.0.0.1:19387', process.env.DSH_TOKEN ?? '');
  const sessions = await adapter.list();
  console.log(`[DSH_OK] 認証・session/list成功。${sessions.length}セッション。会話内容は表示しません。`);
  const sessionId = process.env.DSH_CHECK_SESSION_ID;
  if (sessionId) {
    const snapshot = await adapter.snapshot(sessionId);
    const events = await adapter.events(sessionId, snapshot.cursor, Math.max(-1, snapshot.cursor - 10));
    console.log(`[DSH_HISTORY_OK] projections・page成功。直近${events.length}イベントを検証（内容は非表示）。`);
  }
}
void check().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
