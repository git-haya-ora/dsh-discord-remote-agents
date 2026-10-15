/** Product-internal design contract. None of these names are DSH RPC endpoints. */
export const contractVersion = 1 as const;

/** Connected restricted profile DTOs; independent of the legacy foundation contract below. */
export interface RestrictedSettings {
  guildId: string;
  applicationId: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
  workspaces: Record<string, string>;
  autoStart: boolean;
}
export interface RestrictedCapabilities {
  text: boolean;
  atomicAcceptance: false;
  approval: false;
  cancel: false;
  attachments: false;
  artifacts: false;
}
export interface RestrictedManagementStatus {
  profile: 'single-operator-text-v1';
  revision: number;
  state: 'unconfigured' | 'blocked' | 'stopped' | 'connecting' | 'connected' | 'disposed';
  tokenConfigured: boolean;
  botId?: string;
  botName?: string;
  settings: RestrictedSettings | null;
  capabilities: RestrictedCapabilities;
  activeRuns: number;
  unknownRuns: number;
  pendingNotifications: number;
  unknownNotifications: number;
  lastError?: string;
}
export type RestrictedManagementRequest =
  | { operation: 'status' }
  | { operation: 'test'; token?: string }
  | { operation: 'save'; expectedRevision: number; settings: RestrictedSettings; token?: string }
  | { operation: 'start' | 'reconnect' | 'registerCommands' | 'deleteSecret'; expectedRevision: number; confirmation: true }
  | { operation: 'stop'; expectedRevision: number };
export type RestrictedManagementReply =
  | { ok: true; value: RestrictedManagementStatus | { botId: string; botName: string } }
  | { ok: false; code: string };

export interface NonSecretSettings {
  schemaVersion: 1;
  discord: {
    enabled: boolean; autoStart: boolean; applicationId: string;
    secretRef: string | null;
    allowedGuildIds: readonly string[];
    conversations: readonly { guildId: string; channelId: string; threadId: string | null }[];
    users: readonly { userId: string; roles: readonly ('viewer' | 'operator' | 'admin' | 'approver')[]; workspaceAliases: readonly string[] }[];
  };
  workspaces: readonly { alias: string; path: string }[];
}
/** Empty input means keep; delete is never inferred from an empty field. No get-secret operation. */
export type SecretUpdate = { action: 'keep' } | { action: 'replace'; candidate: string; confirmed: true } | { action: 'delete'; confirmed: true };
export type ManagementRequest =
  | { operation: 'status' | 'diagnose' | 'start' | 'stop' | 'reconnect' }
  | { operation: 'save'; settings: NonSecretSettings; expectedRevision: number }
  | { operation: 'updateSecret'; update: SecretUpdate }
  | { operation: 'migrate'; confirmed: true; legacyReceiverStopped: true; preserveOwnersAndDestinations: true };
export type FailureCode = 'UNSUPPORTED_CAPABILITY' | 'MANAGEMENT_AUTHORIZATION_UNAVAILABLE' | 'INCOMPATIBLE_HOST' | 'DISPOSED' | 'INVALID_CONFIGURATION';
export type ManagementReply = { ok: false; code: FailureCode };
export type CapabilityName =
  | 'sessions.list' | 'sessions.create' | 'sessions.history' | 'sessions.sharedWithDesktop'
  | 'runs.submit' | 'runs.status' | 'runs.cancel' | 'runs.atomicAcceptance' | 'runs.idempotentSubmit'
  | 'approvals.list' | 'approvals.decide' | 'attachments.upload' | 'attachments.imageInput'
  | 'artifacts.download' | 'events.stream' | 'events.resume' | 'desktopRuns.observe'
  | 'management.authorization' | 'secrets.protectedStorage' | 'settings.persist' | 'migration.explicit' | 'discord.receiver';
export interface FoundationStatus {
  contractVersion: 1;
  state: 'unconfigured' | 'blocked' | 'disposed';
  receiverStarted: false;
  nativeRunsTouched: false;
  supportedDshVersion: '0.2.0-rc.2';
  compatibility: 'unverified';
  reasons: readonly string[];
  capabilities: Readonly<Record<CapabilityName, { supported: false; reason: string }>>;
}
