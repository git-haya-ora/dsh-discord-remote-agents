export interface ComponentBindingPin {
  readonly agentId: string;
  readonly nativeSessionId: string;
  readonly version: number;
}

export interface ComponentTargetPin {
  readonly kind: string;
  readonly id: string;
  readonly version: number;
}

/** Exact trusted Discord interaction identity and the state snapshot to which an action is bound. */
export interface DiscordComponentScope {
  readonly actorId: string;
  readonly guildId: string;
  readonly channelId: string;
  /** Use null for a top-level channel; do not omit thread identity. */
  readonly threadId: string | null;
  /** Null for an unbound selection flow; otherwise pin both IDs and Binding version. */
  readonly binding: ComponentBindingPin | null;
  readonly target: ComponentTargetPin;
}

export interface DiscordComponentGrant extends DiscordComponentScope {
  readonly action: string;
  readonly expiresAt: number;
}

export type ComponentAuthorizationRecheck = (
  grant: DiscordComponentGrant,
  current: DiscordComponentScope
) => boolean | Promise<boolean>;

export type ComponentConsumeResult =
  | { readonly ok: true; readonly grant: DiscordComponentGrant }
  | {
      readonly ok: false;
      readonly reason:
        | 'MALFORMED'
        | 'INVALID_SIGNATURE'
        | 'UNKNOWN'
        | 'IN_FLIGHT'
        | 'SCOPE_MISMATCH'
        | 'EXPIRED'
        | 'REVOKED'
        | 'NOT_AUTHORIZED'
        | 'AUTHORIZATION_UNAVAILABLE'
        | 'DISPOSED';
    };

export interface ComponentActionGuardOptions {
  /** Must re-evaluate current server-side role, policy, Binding version and target version. */
  readonly authorize: ComponentAuthorizationRecheck;
  /** Test seam; production should use the default wall clock. */
  readonly now?: () => number;
}

export const COMPONENT_CUSTOM_ID_MAX_LENGTH: 100;
export const COMPONENT_GRANT_DEFAULT_TTL_MS: 300000;
export const COMPONENT_GRANT_MAX_TTL_MS: 900000;

export class ComponentActionGuard {
  constructor(options: ComponentActionGuardOptions);
  /** Issue only after normal application authorization; output contains no scope IDs or action text. */
  issue(scope: DiscordComponentScope, action: string, ttlMs?: number): { readonly customId: string; readonly expiresAt: number };
  /** Consume once, after exact interaction-scope match and a fresh authorization callback. */
  consume(customId: unknown, context: DiscordComponentScope): Promise<ComponentConsumeResult>;
  /** Revoke a valid outstanding identifier, including one currently being authorization-checked. */
  revoke(customId: unknown): boolean;
  revokeAll(): void;
  sweepExpired(): number;
  dispose(): void;
}
