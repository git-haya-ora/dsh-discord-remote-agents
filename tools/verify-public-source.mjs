import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const staged = process.argv.includes('--staged');
const paths = execFileSync('git', staged ? ['diff','--cached','--name-only','--diff-filter=ACMR'] : ['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const forbidden = /(^|\/)(?:\.git|\.research|\.verification|\.contract-type-check|node_modules|dist|data|logs|backups)(?:\/|$)|(^|\/)(?:\.env(?!\.example$)(?:\..*)?|config\.json|telegram\.config\.json)$|\.(?:db|sqlite(?:3|-.*)?|dpapi|credential|bak|log|tgz)$/i;
const patterns = [/mfa\.[A-Za-z0-9_-]{60,}/, /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /[A-Z]:[\\/]Users[\\/](?!USER(?:[\\/]|\b)|Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[^\\/\s"'<>]+/i];
const publicPaths = /^(?:(?:src|test)\/[^/]+\.ts|test\/(?:plugin-client-dom|sqlite-exclusive-lock)\.test\.mjs|packages\/discord-plugin\/[a-z0-9.-]+|scripts\/(?:build-plugin|sync-distribution)\.mjs|tools\/(?:verify-bundle|verify-public-source|verify-publishing-account|export-github-bundle)\.mjs|docs\/[a-z0-9-]+\.md|runtime\/[a-z-]+\.js|(?:README|SECURITY|AGENTS|PRODUCT)\.md|specification\.md|MANIFEST\.sha256|\.env\.example|\.gitattributes|\.gitignore|(?:telegram\.)?config\.example\.json|package(?:-lock)?\.json|tsconfig\.json|[a-z0-9-]+\.(?:js|d\.ts|ps1)|contracts\.ts|cordis\.patch\.yml)$/;
let failed = false;
for (const path of paths) {
  if (!publicPaths.test(path)) { console.error('Unallowlisted public path: '+path); failed=true; continue; }
  if (forbidden.test(path)) { console.error('Forbidden public artifact: '+path); failed=true; continue; }
  const text = staged ? execFileSync('git',['show',':'+path],{encoding:'utf8'}) : readFileSync(path,'utf8');
  if (path === 'package.json' || path === 'packages/discord-plugin/package.json') {
    const manifest = JSON.parse(text);
    if (manifest.private !== true || Object.hasOwn(manifest, 'publishConfig')) { console.error('Registry publication guard missing: '+path); failed=true; }
  }
  if (patterns.some(pattern=>pattern.test(text))) { console.error('Potential sensitive data; value withheld: '+path); failed=true; }
}
if(failed) process.exitCode=1;
else console.log(JSON.stringify({ok:true,inspected:paths.length,staged,scope:'known credential patterns, local user paths, forbidden artifacts; not universal secret or PII proof'}));
