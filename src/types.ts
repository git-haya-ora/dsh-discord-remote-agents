export interface SessionModel { provider: string; model: string; reasoningEffort?: string }
export interface CatalogEffort { id: string; name: string }
export interface CatalogModel { id: string; name: string; reasoning?: { efforts: CatalogEffort[]; defaultEffort?: string } }
export interface CatalogGroup { id: string; name: string; models: CatalogModel[] }
// Safe Host DTO: raw provider failure messages are intentionally discarded by the adapter.
export interface ModelCatalog { default: SessionModel; routableProviders: string[]; groups: CatalogGroup[]; failedProviders: number }
export interface SessionRenameValue { title: string; seq: number }
export interface SessionInfo {
  sessionId: string; cwd?: string; running: boolean; title: string;
  subagent: boolean; updatedAt: number;
  lastUsedModel?: SessionModel; nextModel?: SessionModel;
}
export interface WireEvent { type: string; seq: number; time: number; data: Record<string, unknown>; surfaceOp?: unknown }
export interface Snapshot { cursor: number; values: Record<string, unknown> }
export type RunState = 'dispatching' | 'accepted' | 'running' | 'unknown' | 'succeeded' | 'failed' | 'interrupted';
export type DeliveryPartState = 'pending' | 'sending' | 'sent' | 'unknown' | 'blocked';
export interface DeliveryPart { index: number; state: DeliveryPartState; messageId?: string; attempts: number; nextAttemptAt: number; lastError: string; digest: string }
export interface DeliveryPlan {
  id: string; destination: 'dm' | 'origin'; userId: string; guildId: string; channelId: string;
  bodyDigest: string; digest: string; complete: boolean; codepoints: number; parts: DeliveryPart[];
}
export interface NotificationPreferences { destination: 'dm' | 'origin'; progress: boolean }
export interface Run {
  id: string; requestId: string; sessionId: string; userId: string; guildId: string; channelId: string; revision?: number; bodyExpiresAt?: number;
  state: RunState; createdAt: number; updatedAt: number; lastSeq: number; turn: number | null;
  output: string; result: string; admitted: boolean; contaminated: boolean;
  payloadDigest?: string; startSeq?: number; bodyMissing?: boolean;
  bodyDigest?: string; finalText?: string | undefined; originalFinalDigest?: string | undefined; delivery?: DeliveryPlan | undefined;
  notificationPreferences?: NotificationPreferences; bindingVersion?: number;
  startStep?: { turn: number; step: number; seq: number } | undefined;
  workStartedSeq?: number; workNotice?: 'none' | 'ready' | 'sent' | 'unknown' | 'blocked' | 'suppressed'; workNoticeMessageId?: string; workNoticeAttempts?: number; workNoticeError?: string;
  notification: 'none' | 'pending' | 'sent' | 'unknown'; notifyAttempts: number; nextNotifyAt: number; lastError: string;
}
export const terminal = (state: RunState): boolean => ['succeeded', 'failed', 'interrupted'].includes(state);
export interface AgentAdapter {
  list(): Promise<SessionInfo[]>;
  create(cwd: string): Promise<string>;
  snapshot(sessionId: string): Promise<Snapshot>;
  events(sessionId: string, throughSeq: number, afterSeq: number): Promise<WireEvent[]>;
  prompt(sessionId: string, requestId: string, text: string): Promise<void>;
  modelCatalog?(): Promise<ModelCatalog>;
  rename?(request: { sessionId: string; title: string }): Promise<SessionRenameValue>;
  verifySession?(sessionId: string): Promise<void>;
}
