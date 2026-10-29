import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SQLite exclusive locking remains held after COMMIT in WAL mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-exclusive-fixture-'));
  const path = join(dir, 'fixture.sqlite');
  const first = new DatabaseSync(path);
  let second;
  try {
    first.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES (1);');
    first.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    second = new DatabaseSync(path);
    second.exec('PRAGMA busy_timeout=0;');
    assert.throws(() => second.exec('UPDATE fixture SET value=2;'), /locked|busy/i);
    assert.equal(first.prepare('SELECT value FROM fixture').get().value, 1);
  } finally {
    second?.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
