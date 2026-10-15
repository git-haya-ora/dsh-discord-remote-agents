import { spawnSync } from 'node:child_process';
// Never print, persist or pass Git credentials in command arguments.
const result = spawnSync('git', ['-c', 'credential.interactive=never', 'credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
});
if (result.error || result.status !== 0) {
  console.error('GitHub identity could not be verified: credential helper unavailable.');
  process.exit(1);
}
const fields = new Map(result.stdout.split(/\r?\n/u).flatMap(line => {
  const separator = line.indexOf('=');
  return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
}));
const password = fields.get('password');
fields.clear();
result.stdout = '';
result.stderr = '';
if (!password) {
  console.error('GitHub identity could not be verified: no credential supplied.');
  process.exit(1);
}
try {
  const response = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${password}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const account = await response.json();
  if (account.login !== 'git-haya-ora') throw new Error('Unexpected account');
  console.log('Verified GitHub account: git-haya-ora');
} catch {
  console.error('GitHub identity could not be verified; no credential values were displayed.');
  process.exitCode = 1;
}
