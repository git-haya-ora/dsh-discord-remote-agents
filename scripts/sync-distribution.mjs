import { readFile, writeFile, copyFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const plugin = new URL('packages/discord-plugin/', root);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const sourceManifest = JSON.parse(await readFile(new URL('package.json', plugin), 'utf8'));
// Source and installable root must have exactly the same supported bundle contract.
for (const candidate of [manifest, sourceManifest]) {
  if (candidate.private !== true || Object.hasOwn(candidate, 'publishConfig')) throw new Error('Registry publication is disabled for this GitHub bundle');
}
for (const key of ['name','version','private','exports','files','dependencies','engines','dsh']) {
  if (JSON.stringify(manifest[key]) !== JSON.stringify(sourceManifest[key])) throw new Error('Distribution contract mismatch: '+key);
}
const files = ['package.json'];
for (const entry of sourceManifest.files) {
  if (entry === 'runtime/') {
    await mkdir(new URL('runtime/', root), { recursive: true });
    const names = await readdir(new URL(entry, plugin));
    if (names.some(name => !/^[a-z-]+\.js$/.test(name))) throw new Error('Unexpected runtime member');
    const old = await readdir(new URL('runtime/', root));
    if (old.some(name => !names.includes(name))) throw new Error('Stale root runtime; inspect manually, never silently delete');
    for (const name of names) files.push(entry+name);
  } else {
    if (!/^[a-z0-9.-]+$/.test(entry)) throw new Error('Unsafe distribution entry');
    files.push(entry);
  }
}
const check = process.argv.includes('--check');
for (const path of files) if (path !== 'package.json') {
  if (check) {
    if (!(await readFile(new URL(path,plugin))).equals(await readFile(new URL(path,root)))) throw new Error('Generated distribution drift: '+path);
  } else await copyFile(new URL(path,plugin),new URL(path,root));
}
const hashes = await Promise.all(files.sort().map(async path => `${createHash('sha256').update(await readFile(new URL(path,root))).digest('hex')}  ${path}`));
const inventory = hashes.join('\n')+'\n';
if (check) {
  if (await readFile(new URL('MANIFEST.sha256',root),'utf8') !== inventory) throw new Error('Distribution inventory drift');
} else await writeFile(new URL('MANIFEST.sha256',root),inventory);
console.log(`${check ? 'Verified' : 'Updated'} root installable distribution (${files.length} files); no lifecycle scripts required.`);
