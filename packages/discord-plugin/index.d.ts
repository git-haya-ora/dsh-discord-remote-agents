import type { FoundationStatus, ManagementReply, ManagementRequest } from './contracts.js';
export class FoundationHost {
  constructor(config?: unknown);
  status(): FoundationStatus;
  dispatch(request: ManagementRequest): Promise<ManagementReply>;
  dispose(): Promise<void>;
}
export { DiscordHost } from './host-runtime.js';
export const inject: string[];
export type { DiscordHostContext as HostEffectContext } from './host-runtime.js';
export function apply(ctx: import('./host-runtime.js').DiscordHostContext, config?: unknown): void;
