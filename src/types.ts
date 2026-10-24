export interface SessionModel { provider: string; model: string; reasoningEffort?: string }
export interface CatalogEffort { id: string; name: string }
export interface CatalogModel { id: string; name: string; reasoning?: { efforts: CatalogEffort[]; defaultEffort?: string } }
export interface CatalogGroup { id: string; name: string; models: CatalogModel[] }
// Safe Host DTO: raw provider failure messages are intentionally discarded by the adapter.
export interface ModelCatalog { default: SessionModel; routableProviders: string[]; groups: CatalogGroup[]; failedProviders: number }
export interface SessionRenameValue { title: string; seq: number }
/** Read-only, selected Native context projections; these values are not one atomic usage sample. */
export interface ContextMetrics {
  readonly pressureTokens?: number;
  readonly projectedTokens?: number;
  readonly contextWindow?: number;
  readonly systemTokens?: number;
  readonly toolsTokens?: number;
  readonly messageTokens?: number;
  readonly asOfSeq?: number;
}
export type CompactMaintenanceState = 'unknown' | 'completed' | 'noop';
/** Local no-replay journal only; it never asserts Native history text was erased. */
export interface CompactMaintenanceIntent {
  schemaVersion: 1; intentId: string; sessionId: string; agentId: string; applicationId: string; botId: string;
  ownerId: string; guildId: string; channelId: string; bindingMode: 'actor' | 'shared'; bindingId: string; bindingVersion: number;
  workspaceDigest: string; definitionId: '@deepseek-ai/dsh-command-compact'; state: CompactMaintenanceState; dispatchedAt: number;
  commandId?: string; sourceEventSeq?: number; outcomeAt?: number;
}
export interface CompactTarget { readonly sessionId: string; readonly agentId: string; readonly cwd: string; readonly definitionId: '@deepseek-ai/dsh-command-compact' }
export interface CompactExecution {
  readonly commandId: string;
  readonly result: { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number } | { readonly kind: 'error'; readonly text: string };
}
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
export interface BridgeOutputContext {
  profile: 'local-bridge-output-v1'; transport: 'discord'; applicationId: string; botId: string;
  nativeSessionId: string; bridgeRunId: string; clientRequestId: string; promptDigest: string;
  observedTurn: number | null; bridgeStartSeq: number; lastObservedSeq: number;
  completionSource: 'native-turn' | 'bridge-rejection'; terminalState: 'succeeded' | 'failed' | 'interrupted';
  ownerId: string; guildId: string; channelId: string; threadId: null; bindingMode: 'actor' | 'shared'; bindingId: string; bindingVersion: number;
  destination: 'dm' | 'origin'; preRedactionDigest: string | null; redactedBodyDigest: string; deliveryPlanDigest: string;
  itemKind: 'body' | 'part'; itemIndex: number; itemCount: number; itemDigest: string;
}
export interface ProtectedOutputItem {
  ref: string; kind: 'body' | 'part'; index: number; count: number; digest: string;
  contentDigest: string; byteLength: number; cipherBytes: number; context: BridgeOutputContext;
}
export type ProtectedOutputState = 'published' | 'retiring' | 'retired';
export interface ProtectedOutputManifest {
  schemaVersion: 1; profile: 'local-bridge-output-v1'; intentId: string;
  state: ProtectedOutputState; outputDigest: string; bodyDigest: string; deliveryPlanDigest: string;
  items: ProtectedOutputItem[]; createdAt: number; resolvedAt?: number; expiresAt?: number; deletedRefs: string[];
}
export interface ProtectedOutputIntent {
  schemaVersion: 1; profile: 'local-bridge-output-v1'; intentId: string; runId: string;
  state: 'prepared' | 'published' | 'retiring' | 'retired'; outputDigest: string; bodyDigest: string; deliveryPlanDigest: string;
  items: ProtectedOutputItem[]; createdAt: number; reservedMetadataBytes: number; resolvedAt?: number; expiresAt?: number; deletedRefs: string[];
}
export interface ProtectedPayloadStore {
  estimate(inputs: readonly { kind: 'bridge-output'; context: BridgeOutputContext; text: string }[]): Promise<Array<{ digest: string; byteLength: number; cipherBytes: number }>>;
  createWithRef(ref: string, input: { kind: 'bridge-output'; context: BridgeOutputContext; text: string }, reserveBytes: number): Promise<void>;
  createManyWithRefs(inputs: readonly { ref: string; input: { kind: 'bridge-output'; context: BridgeOutputContext; text: string }; reserveBytes: number }[]): Promise<void>;
  read(ref: string, expected: { kind: 'bridge-output'; digest: string; context: BridgeOutputContext }): Promise<{ text: string }>;
  readMany(inputs: readonly { ref: string; expected: { kind: 'bridge-output'; digest: string; context: BridgeOutputContext } }[]): Promise<readonly { text: string }[]>;
  stats(): Promise<{ bytes: number; files: Array<{ ref: string; bytes: number }> }>;
  delete(ref: string): Promise<void>;
  deleteMany(refs: readonly string[]): Promise<readonly { ref: string; deleted: boolean; bytes: number }[]>;
}
export interface NotificationPreferences { destination: 'dm' | 'origin'; progress: boolean }
export interface Run {
  id: string; requestId: string; sessionId: string; userId: string; guildId: string; channelId: string; revision?: number; bodyExpiresAt?: number;
  state: RunState; createdAt: number; updatedAt: number; lastSeq: number; turn: number | null;
  output: string; result: string; admitted: boolean; contaminated: boolean;
  payloadDigest?: string; startSeq?: number; bodyMissing?: boolean;
  bodyDigest?: string; finalText?: string | undefined; originalFinalDigest?: string | undefined; delivery?: DeliveryPlan | undefined;
  notificationPreferences?: NotificationPreferences; bindingVersion?: number;
  protectedOutput?: ProtectedOutputManifest; bodyResolvedAt?: number; requiresProtectedOutput?: boolean;
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
  contextMetrics?(sessionId: string, cwd: string): ContextMetrics | undefined;
  verifySession?(sessionId: string): Promise<void>;
  prepareCompactTarget?(sessionId: string, cwd: string): Promise<CompactTarget>;
  isCompactTargetCurrent?(target: CompactTarget): boolean;
  executeCompact?(target: CompactTarget, signal: AbortSignal): Promise<CompactExecution | undefined>;
}
