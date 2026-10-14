import type { RestrictedManagementReply, RestrictedManagementRequest, RestrictedManagementStatus, RestrictedSettings } from './contracts.js';
export const RPC_CHANNEL: '/discord-remote-agents';
export const RPC_ENDPOINT: 'manage';
export class HostError extends Error { readonly code: string; constructor(code: string); }
export function validateManagementRequest(request: unknown): RestrictedManagementRequest;
export function validateSettings(value: unknown): RestrictedSettings;
export function validateBot(candidate: string, fetcher?: typeof fetch, signal?: AbortSignal): Promise<{ botId: string; botName: string; applicationId: string }>;
export interface DiscordHostContext {
  connection: { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<RestrictedManagementReply>): () => void } };
  sessionController: { list: Function; create: Function; projections: Function; page: Function; prompt: Function };
  effect(factory: () => (() => void) | (() => Promise<void>)): unknown;
}
export class DiscordHost {
  constructor(ctx: DiscordHostContext, config?: unknown, internals?: Record<string, unknown>);
  dispatch(request: unknown, signal?: AbortSignal): Promise<RestrictedManagementReply>;
  status(): RestrictedManagementStatus;
  boot(): Promise<void>;
  dispose(): Promise<void>;
}
