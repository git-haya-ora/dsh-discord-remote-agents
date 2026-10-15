// Offline declaration-consumer evidence, not Host/live integration evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('restricted Host declarations compile for consumers with skipLibCheck disabled', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../../restricted-contract-consumer.ts', import.meta.url));
  const source = `
import { validateSettings, validateManagementRequest, DiscordHost } from './packages/discord-plugin/host-runtime.js';
import type { RestrictedSettings, RestrictedManagementStatus, RestrictedCapabilities, RestrictedManagementRequest, RestrictedManagementReply, NonSecretSettings } from './packages/discord-plugin/contracts.js';
const settings: RestrictedSettings = validateSettings({});
const guild: string = settings.guildId;
const requests: RestrictedManagementRequest[] = [
 { operation: 'status' }, { operation: 'test', token: '' },
 { operation: 'save', expectedRevision: 0, settings },
 { operation: 'start', expectedRevision: 0, confirmation: true },
 { operation: 'reconnect', expectedRevision: 0, confirmation: true },
 { operation: 'registerCommands', expectedRevision: 0, confirmation: true },
 { operation: 'deleteSecret', expectedRevision: 0, confirmation: true },
 { operation: 'stop', expectedRevision: 0 }
];
// @ts-expect-error start requires explicit confirmation
const unconfirmed: RestrictedManagementRequest = { operation: 'start', expectedRevision: 0 };
// @ts-expect-error stop requires optimistic revision
const unversioned: RestrictedManagementRequest = { operation: 'stop' };
// @ts-expect-error no get-secret operation
const secretRead: RestrictedManagementRequest = { operation: 'getSecret' };
declare const host: DiscordHost;
const status: RestrictedManagementStatus = host.status();
const capabilities: RestrictedCapabilities = status.capabilities;
const unavailable: false = capabilities.cancel;
const nullable: RestrictedSettings | null = status.settings;
const reply: Promise<RestrictedManagementReply> = host.dispatch(validateManagementRequest(requests[0]));
declare const legacy: NonSecretSettings;
const legacyVersion: 1 = legacy.schemaVersion;
`;
  const options: ts.CompilerOptions = {
    strict: true, skipLibCheck: false, noEmit: true, target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getCurrentDirectory = () => root;
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name.replaceAll('\\', '/') === fixture.replaceAll('\\', '/') ? ts.createSourceFile(name, source, languageVersion, true) : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fixture], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});
