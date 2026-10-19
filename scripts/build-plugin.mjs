import { mkdir, copyFile, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const destination = new URL('packages/discord-plugin/runtime/', root);
await mkdir(destination, { recursive: true });
// Explicit self-contained allowlist. Legacy HTTP/env/Telegram entrypoints are not shipped.
const names = ['engine', 'store', 'policy', 'types', 'errors', 'protocol', 'output', 'bot', 'commands', 'command-handler', 'connection-notice'];
const allowed = new Set(names.map(name => `${name}.js`));
if ((await readdir(destination, { withFileTypes: true })).some(entry => !entry.isFile() || !allowed.has(entry.name))) {
  throw new Error('Unexpected packaged runtime entry; refusing stale output without deleting it');
}
for (const name of names) {
  const source = new URL(`dist/src/${name}.js`, root);
  const text = await readFile(source, 'utf8');
  if (text.includes('./dsh.js') || text.includes('./config.js')) throw new Error('Host runtime must not import legacy transport/config');
  await copyFile(fileURLToPath(source), fileURLToPath(new URL(`${name}.js`, destination)));
}
console.log(`Prepared self-contained Host runtime (${names.length} modules).`);
