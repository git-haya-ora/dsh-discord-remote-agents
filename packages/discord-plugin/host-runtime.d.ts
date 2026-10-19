import type { RestrictedManagementReply, RestrictedManagementRequest, RestrictedManagementStatus, RestrictedSettings } from './contracts.js';
export const RPC_CHANNEL: '/api';
export const RPC_ENDPOINT: 'discord-remote-agents.manage';
export class HostError extends Error { readonly code: string; constructor(code: string); }
export function validateManagementRequest(request: unknown): RestrictedManagementRequest;
export function validateSettings(value: unknown): RestrictedSettings;
export function validateBot(candidate: string, fetcher?: typeof fetch, signal?: AbortSignal): Promise<{ botId: string; botName: string; applicationId: string }>;
export interface DiscordHostContext {
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => void } };
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
