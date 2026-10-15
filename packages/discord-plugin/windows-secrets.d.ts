/** Dedicated admission filenames only; same SID ACL/ancestry policy as secret journal. */
export function prepareAdmissionJournalRoot(root: string): Promise<void>;
/** Dedicated Outbox-only filenames; same SID/ancestry policy, no root widening. */
export function prepareOutboxJournalRoot(root: string): Promise<void>;
/** Dedicated unified store filenames; no migration or existing-root widening. */
export function prepareRunOutboxJournalRoot(root: string): Promise<void>;
export class ProtectedStoreError extends Error { readonly code: string; constructor(code?: string); }
/** Host-only interface. Never return read() data through Remote/Client. */
export interface HostSecretStore { create(candidate: string): Promise<string>; read(ref: string): Promise<string>; retire(ref: string): Promise<void>; }
export class WindowsSecretStore implements HostSecretStore {
  constructor(root: string);
  create(candidate: string): Promise<string>;
  read(ref: string): Promise<string>;
  retire(ref: string): Promise<void>;
}
export interface SecretJournalState {
  revision: number; activeRef: string | null;
  pending: null | { candidateRef: string; previousRef: string | null; phase: 'candidate' | 'switched' } | { candidateRef: null; previousRef: string; phase: 'deleting' };
}
/** Must atomically and durably compare revision and replace the entire state. */
export interface SecretJournal {
  withExclusive<T>(action: () => Promise<T>): Promise<T>;
  load(): Promise<SecretJournalState>;
  compareAndSwap(expectedRevision: number, state: SecretJournalState): Promise<boolean>;
}
export class SecretLifecycle {
  constructor(store: HostSecretStore, journal: SecretJournal);
  replace(candidate: string, expectedRevision: number, verifier: (candidate: string) => Promise<boolean>): Promise<{ revision: number; configured: boolean }>;
  keep(expectedRevision: number): Promise<{ revision: number; configured: boolean }>;
  delete(expectedRevision: number, confirmed: boolean): Promise<{ revision: number; configured: boolean }>;
  recover(): Promise<{ revision: number; configured: boolean }>;
}
