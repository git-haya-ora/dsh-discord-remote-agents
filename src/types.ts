export interface SessionInfo {
  sessionId: string; cwd?: string; running: boolean; title: string;
  subagent: boolean; updatedAt: number;
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
  notification: 'none' | 'pending' | 'sent' | 'unknown'; notifyAttempts: number; nextNotifyAt: number; lastError: string;
}
export const terminal = (state: RunState): boolean => ['succeeded', 'failed', 'interrupted'].includes(state);
export interface AgentAdapter {
  list(): Promise<SessionInfo[]>;
  create(cwd: string): Promise<string>;
  snapshot(sessionId: string): Promise<Snapshot>;
  events(sessionId: string, throughSeq: number, afterSeq: number): Promise<WireEvent[]>;
  prompt(sessionId: string, requestId: string, text: string): Promise<void>;
}
