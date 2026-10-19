import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../src/config.js';
import { command } from '../src/commands.js';
import { handleAgentCommand } from '../src/command-handler.js';
import { Engine, type Actor } from '../src/engine.js';
import { Policy } from '../src/policy.js';
import { Store } from '../src/store.js';
import type { AgentAdapter, SessionInfo, Snapshot, WireEvent } from '../src/types.js';

const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
const secret = 'SECRET_TOKEN';
type SafeHistoryEntry = { seq: number; role: 'user' | 'assistant'; text: string };

class CommandAdapter implements AgentAdapter {
  rows: SessionInfo[] = [];
  cursor = 10;
  listCalls = 0;
  createCalls = 0;
  snapshotCalls = 0;
  eventCalls = 0;
  promptCalls = 0;
  historyCalls = 0;
  history: ((sessionId: string, throughSeq: number, afterSeq: number) => Promise<SafeHistoryEntry[]>) | undefined;

  async list(): Promise<SessionInfo[]> { this.listCalls++; return this.rows; }
  async create(cwd: string): Promise<string> {
    this.createCalls++;
    this.rows.push({ sessionId: 'created', cwd, running: false, title: 'created', subagent: false, updatedAt: 99 });
    return 'created';
  }
  async snapshot(_sessionId: string): Promise<Snapshot> {
    this.snapshotCalls++;
    return { cursor: this.cursor, values: { inbox: { 'next-turn': [], 'next-step': [] } } };
  }
  async events(_sessionId: string, throughSeq: number, afterSeq: number): Promise<WireEvent[]> {
    this.eventCalls++;
    return Array.from({ length: Math.max(0, throughSeq - afterSeq) }, (_, i) => ({ seq: afterSeq + i + 1, type: 'heartbeat', time: 1, data: {} }));
  }
  async prompt(): Promise<void> { this.promptCalls++; }
}

type Inputs = Record<string, string | number | boolean>;
function interaction(
  subcommand: string,
  inputs: Inputs = {},
  options: { group?: string; userId?: string; guildId?: string | null; channelId?: string | null } = {}
): ChatInputCommandInteraction {
  const values = inputs;
  const rawSubcommandOptions = Object.entries(values).map(([name, value]) => ({ name, value }));
  const rawSubcommand = { name: subcommand, options: rawSubcommandOptions };
  const rawData = options.group ? [{ name: options.group, options: [rawSubcommand] }] : [rawSubcommand];
  const resolver = {
    data: rawData,
    getSubcommandGroup: () => options.group ?? null,
    getSubcommand: () => subcommand,
    getString: (name: string) => typeof values[name] === 'string' ? values[name] as string : null,
    getInteger: (name: string) => typeof values[name] === 'number' ? values[name] as number : null,
    getBoolean: (name: string) => typeof values[name] === 'boolean' ? values[name] as boolean : null
  };
  return {
    id: 'interaction-111', commandName: 'agent',
    user: { id: options.userId ?? actor.userId, bot: false },
    guildId: options.guildId === undefined ? actor.guildId : options.guildId,
    channelId: options.channelId === undefined ? actor.channelId : options.channelId,
    options: resolver
  } as unknown as ChatInputCommandInteraction;
}

async function setup(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'command-handler-test-'));
  const config: Config = {
    token: 'test-discord-token', applicationId: '444444444444444444', guildId: actor.guildId,
    allowedUserIds: new Set([actor.userId]), allowedChannelIds: new Set([actor.channelId]),
    workspaces: { test: dir }, dshUrl: 'http://127.0.0.1:19387', dshToken: secret,
    pollIntervalMs: 5000, databasePath: join(dir, 'bot.sqlite')
  };
  const policy = await Policy.create(config);
  const store = new Store(config.databasePath, true);
  store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  const adapter = new CommandAdapter();
  adapter.rows = [{ sessionId: 'old-session-id', cwd: dir, running: false, title: 'existing session', updatedAt: 1, subagent: false }];
  const engine = new Engine(adapter, store, policy, [secret]);
  await engine.bind(actor, 'old-session-id');
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, store, adapter, engine };
}

test('command schema stays within Discord option limits and excludes unverified writes/history', () => {
  const schema = command.toJSON() as unknown as { options: Array<{ name: string; type: number; options?: Array<{ name: string; type: number; options?: unknown[] }> }> };
  assert.equal(schema.options.length, 15);
  assert.ok(schema.options.length <= 25);
  const names = new Set(schema.options.map(option => option.name));
  for (const forbidden of ['history', 'models', 'model', 'reasoning', 'context', 'settings', 'stop', 'approval', 'queue', 'files']) assert.equal(names.has(forbidden), false);
  for (const root of schema.options) {
    assert.ok((root.options?.length ?? 0) <= 25, `${root.name} options exceed limit`);
    for (const child of root.options ?? []) assert.ok((child.options?.length ?? 0) <= 25, `${root.name}.${child.name} options exceed limit`);
  }
  const allNames = schema.options.flatMap(root => [root, ...(root.options ?? [])]).map(option => option.name);
  assert.equal(allNames.includes('progress'), false);
});

test('workspace registration requires authorization, confirmation and a supported Host callback', async t => {
  const { engine, config } = await setup(t);
  const inputs = { alias: 'project', path: '/synthetic/project', 'confirm-access': true };
  await assert.rejects(handleAgentCommand(interaction('workspace-add', inputs), engine, config, true), { code: 'WORKSPACE_SETUP_UNAVAILABLE' });
  const calls: unknown[] = [];
  engine.registerWorkspace = async (...args) => { calls.push(args); };
  await assert.rejects(handleAgentCommand(interaction('workspace-add', { ...inputs, 'confirm-access': false }), engine, config, true), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(handleAgentCommand(interaction('workspace-add', inputs, { userId: '999999999999999999' }), engine, config, true), { code: 'NOT_AUTHORIZED' });
  assert.equal(calls.length, 0);
  const reply = await handleAgentCommand(interaction('workspace-add', inputs), engine, config, true);
  assert.equal(calls.length, 1); assert.ok(!reply.content.includes(inputs.path));
  assert.ok(reply.content.includes('/agent new'));
});

test('cross-user and DM rejection happen before adapter operations', async t => {
  const { engine, adapter, config } = await setup(t);
  const before = { list: adapter.listCalls, prompt: adapter.promptCalls, create: adapter.createCalls, events: adapter.eventCalls };
  await assert.rejects(handleAgentCommand(interaction('current', {}, { userId: '999999999999999999' }), engine, config, true), { code: 'NOT_AUTHORIZED' });
  await assert.rejects(handleAgentCommand(interaction('current', {}, { guildId: null, channelId: null }), engine, config, true), { code: 'NOT_AUTHORIZED' });
  assert.deepEqual({ list: adapter.listCalls, prompt: adapter.promptCalls, create: adapter.createCalls, events: adapter.eventCalls }, before);
});

test('authorized session search pagination is bounded and stable', async t => {
  const { engine, config, adapter } = await setup(t);
  adapter.rows = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `session-${String(index).padStart(2, '0')}`, cwd: config.workspaces.test!, running: index === 5,
    title: `title-${String(index).padStart(2, '0')}`, updatedAt: 100 - index, subagent: false
  }));
  const response = await handleAgentCommand(interaction('sessions', { query: 'TITLE-', page: 2 }), engine, config, true);
  assert.match(response.content, /2\/3（12件）/u);
  for (const id of ['session-05', 'session-06', 'session-07', 'session-08', 'session-09']) assert.ok(response.content.includes(id));
  for (const id of ['session-00', 'session-04', 'session-10', 'session-11']) assert.equal(response.content.includes(id), false);
  assert.ok(response.content.length <= 2000);
});

test('current, workspace alias, and task views show only authorized summary fields', async t => {
  const { engine, config, adapter } = await setup(t);
  adapter.rows[0]!.running = true;
  const current = await handleAgentCommand(interaction('current'), engine, config, true);
  assert.match(current.content, /Session ID: old-session-id/u);
  assert.match(current.content, /Workspace: test/u);
  assert.match(current.content, /Busy: 実行中／処理待ちあり/u);
  assert.match(current.content, /Binding version: 1/u);
  assert.doesNotMatch(current.content, new RegExp(config.workspaces.test!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  adapter.rows[0]!.running = false;
  const workspaces = await handleAgentCommand(interaction('workspaces', { page: 1 }), engine, config, true);
  assert.match(workspaces.content, /test/u);
  assert.doesNotMatch(workspaces.content, new RegExp(config.workspaces.test!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  await engine.submit(actor, 'run-task-1', 'test instruction');
  const tasks = await handleAgentCommand(interaction('tasks', { state: 'accepted', page: 1 }), engine, config, true);
  assert.match(tasks.content, /run-task-1/u);
  assert.match(tasks.content, /受付済み/u);
  assert.match(tasks.content, /Session old-session-id/u);
});

test('history is unregistered and injected invocations fail before snapshot/page/events', async t => {
  const { engine, config, adapter } = await setup(t);
  adapter.history = async () => { adapter.historyCalls++; return []; };
  const before = { list: adapter.listCalls, snapshot: adapter.snapshotCalls, events: adapter.eventCalls, history: adapter.historyCalls };
  await assert.rejects(handleAgentCommand(interaction('history'), engine, config, true), { code: 'HISTORY_UNAVAILABLE' });
  const help = await handleAgentCommand(interaction('help', { topic: 'history' }), engine, config, true);
  assert.match(help.content, /正式filter/u);
  assert.deepEqual({ list: adapter.listCalls, snapshot: adapter.snapshotCalls, events: adapter.eventCalls, history: adapter.historyCalls }, before);
});

test('notification scope confirmation and status counters are explicit', async t => {
  const { engine, config } = await setup(t);
  const show = await handleAgentCommand(interaction('show', {}, { group: 'notifications' }), engine, config, true);
  for (const term of ['未送信／再試行待ち', '配送不明／sending', 'blocked', '自動配信未完了', '未送信part数', actor.userId, actor.guildId, actor.channelId, 'old-session-id']) assert.ok(show.content.includes(term));
  await assert.rejects(handleAgentCommand(interaction('set', { destination: 'origin' }, { group: 'notifications' }), engine, config, true), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(engine.notificationPreferences(actor).destination, 'dm');
  const set = await handleAgentCommand(interaction('set', { destination: 'origin', 'confirm-origin': true }, { group: 'notifications' }), engine, config, true);
  assert.equal(engine.notificationPreferences(actor).destination, 'origin');
  assert.match(set.content, /User 111111111111111111 \/ Guild 222222222222222222 \/ Channel 333333333333333333 \/ Binding old-session-id \/ version 1/u);
  assert.match(set.content, /今後のRun/u);
});

test('unregistered model/settings/stop operations fail with zero Native side effects', async t => {
  const { engine, config, adapter, store } = await setup(t);
  const beforeBinding = engine.binding(actor);
  const beforeCalls = { list: adapter.listCalls, prompt: adapter.promptCalls, create: adapter.createCalls, snapshot: adapter.snapshotCalls, events: adapter.eventCalls };
  for (const name of ['model', 'settings', 'stop', 'approval', 'queue', 'files']) {
    await assert.rejects(handleAgentCommand(interaction(name), engine, config, true), { code: 'UNKNOWN_COMMAND' });
  }
  const help = await handleAgentCommand(interaction('help', { topic: 'model' }), engine, config, true);
  assert.match(help.content, /model catalog/u);
  adapter.history = async () => { adapter.historyCalls++; return []; };
  const diagnose = await handleAgentCommand(interaction('diagnose'), engine, config, true);
  assert.match(diagnose.content, /History: unavailable（official field-filtered Native contract unverified）/u);
  assert.equal(adapter.historyCalls, 0);
  assert.deepEqual({ list: adapter.listCalls, prompt: adapter.promptCalls, create: adapter.createCalls, snapshot: adapter.snapshotCalls, events: adapter.eventCalls }, { ...beforeCalls, list: beforeCalls.list + 1 });
  assert.equal(engine.binding(actor), beforeBinding);
  assert.equal(store.allRuns().length, 0);
});

test('injected /new title, model, or effort are rejected before Native create', async t => {
  const { engine, config, adapter } = await setup(t);
  const initialListCalls = adapter.listCalls;
  for (const option of ['title', 'model', 'effort']) {
    const inputs: Inputs = { workspace: 'test' };
    inputs[option] = 'injected-value';
    await assert.rejects(handleAgentCommand(interaction('new', inputs), engine, config, true), { code: 'CREATE_OPTION_UNSUPPORTED' });
  }
  assert.equal(adapter.createCalls, 0);
  assert.equal(adapter.listCalls, initialListCalls);
});
