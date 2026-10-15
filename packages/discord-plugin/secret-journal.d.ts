import type { SecretJournal, SecretJournalState } from './windows-secrets.js';
/** Host-only product API, not a DSH service. Dedicated private root; never expose load() via RPC. */
export class SQLiteSecretJournal implements SecretJournal {
  private constructor();
  static open(root: string): Promise<SQLiteSecretJournal>;
  withExclusive<T>(action: () => Promise<T>): Promise<T>;
  load(): Promise<SecretJournalState>;
  compareAndSwap(expectedRevision: number, state: SecretJournalState): Promise<boolean>;
  close(): void;
}
