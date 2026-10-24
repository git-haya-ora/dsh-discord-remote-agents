import { join, isAbsolute } from 'node:path';
import { Store } from './runtime/store.js';
import { Engine } from './runtime/engine.js';
import { Policy } from './runtime/policy.js';
import { DiscordBot } from './runtime/bot.js';
import { command } from './runtime/commands.js';
import { NativeSessionAdapter } from './native-adapter.js';
import { WindowsSecretStore, prepareAdmissionJournalRoot, isSecretRef } from './windows-secrets.js';
import { WindowsProtectedPayloadStore } from './protected-payloads.js';

export const RPC_CHANNEL = '/api';
export const RPC_ENDPOINT = 'discord-remote-agents.manage';
const profile = 'single-operator-text-v1';
const capabilities = Object.freeze({ text: true, atomicAcceptance: false, approval: false, cancel: false, attachments: false, artifacts: false });
const emptyCapabilities = Object.freeze({ ...capabilities, text: false });
const stateKey = 'restricted-profile-settings';
const id = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
export class HostError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new HostError(code); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_REQUEST'); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 10) fail('INVALID_REQUEST'); }
function token(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 4096 || /[\r\n\0]/.test(value)) fail('INVALID_TOKEN');
  return value.trim();
}
export function validateSettings(value) {
  keys(value, ['guildId', 'applicationId', 'allowedUserIds', 'allowedChannelIds', 'workspaces', 'autoStart', 'connectionNotifications']);
  if (value.connectionNotifications !== undefined) {
    keys(value.connectionNotifications, ['dm', 'channels']);
    if (typeof value.connectionNotifications.dm !== 'boolean' || typeof value.connectionNotifications.channels !== 'boolean') fail('SETTINGS_INVALID');
  }
  if (!id(value.guildId) || !id(value.applicationId) || typeof value.autoStart !== 'boolean') fail('SETTINGS_INVALID');
  const ids = input => {
    if (!Array.isArray(input) || input.length < 1 || input.length > 100 || !input.every(id) || new Set(input).size !== input.length) fail('SETTINGS_INVALID');
    return [...input];
  };
  if (!record(value.workspaces) || Object.keys(value.workspaces).length > 32) fail('SETTINGS_INVALID');
  const workspaces = Object.create(null);
  for (const [alias, path] of Object.entries(value.workspaces)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias) || typeof path !== 'string' || path.length > 1024 || !isAbsolute(path) || /[\0\r\n]/.test(path)) fail('SETTINGS_INVALID');
    workspaces[alias] = path;
  }
  return { guildId: value.guildId, applicationId: value.applicationId, allowedUserIds: ids(value.allowedUserIds), allowedChannelIds: ids(value.allowedChannelIds), workspaces, autoStart: value.autoStart, ...(value.connectionNotifications === undefined ? {} : { connectionNotifications: { dm: value.connectionNotifications.dm, channels: value.connectionNotifications.channels } }) };
}
export function validateManagementRequest(request) {
  if (!record(request) || Buffer.byteLength(JSON.stringify(request), 'utf8') > 65536) fail('INVALID_REQUEST');
  switch (request.operation) {
    case 'status': keys(request, ['operation']); break;
    case 'test': keys(request, ['operation', 'token']); if (request.token !== undefined && request.token !== '') token(request.token); break;
    case 'save':
      keys(request, ['operation', 'expectedRevision', 'settings', 'token']); revision(request.expectedRevision); validateSettings(request.settings);
      if (request.token !== undefined && request.token !== '') token(request.token); break;
    case 'start': case 'reconnect': case 'registerCommands': case 'deleteSecret':
      keys(request, ['operation', 'expectedRevision', 'confirmation']); revision(request.expectedRevision);
      if (request.confirmation !== true) fail('CONFIRMATION_REQUIRED'); break;
    case 'stop': keys(request, ['operation', 'expectedRevision']); revision(request.expectedRevision); break;
    default: fail('INVALID_REQUEST');
  }
  return request;
}
async function boundedJson(response) {
  const reader = response.body?.getReader(); if (!reader) fail('DISCORD_RESPONSE_INVALID');
  let length = 0; const parts = [];
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > 65536) { await reader.cancel(); fail('DISCORD_RESPONSE_INVALID'); }
      parts.push(part.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch { fail('DISCORD_RESPONSE_INVALID'); }
}
async function discordRequest(fetcher, candidate, path, init = {}, externalSignal) {
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  let response;
  try { response = await fetcher(`https://discord.com/api/v10${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bot ${candidate}` }, signal, redirect: 'error' }); }
  catch { fail('DISCORD_OFFLINE'); }
  if (!response.ok) { await response.body?.cancel(); fail(response.status === 401 ? 'DISCORD_AUTH' : response.status === 403 ? 'DISCORD_FORBIDDEN' : 'DISCORD_HTTP'); }
  return boundedJson(response);
}
export async function validateBot(candidate, fetcher = fetch, signal) {
  candidate = token(candidate);
  const user = await discordRequest(fetcher, candidate, '/users/@me', {}, signal);
  const application = await discordRequest(fetcher, candidate, '/applications/@me', {}, signal);
  if (!record(user) || !id(user.id) || user.bot !== true || typeof user.username !== 'string' || !record(application) || !id(application.id) || application.bot !== undefined && (!record(application.bot) || application.bot.id !== user.id)) fail('DISCORD_RESPONSE_INVALID');
  return { botId: user.id, botName: user.username.slice(0, 100), applicationId: application.id };
}
function productConfig(settings, candidate, databasePath) {
  return { ...settings, token: candidate, allowedUserIds: new Set(settings.allowedUserIds), allowedChannelIds: new Set(settings.allowedChannelIds),
    dshUrl: '', dshToken: '', pollIntervalMs: 5000, databasePath };
}
function safeCode(error) {
  // Product-owned errors carry fixed codes. Never serialize upstream exception messages/stacks.
  const known = new Set(['INVALID_REQUEST', 'INVALID_TOKEN', 'SETTINGS_INVALID', 'CONFIRMATION_REQUIRED', 'REVISION_CONFLICT', 'DISPOSED', 'MANAGEMENT_BUSY',
    'DATA_ROOT_REQUIRED', 'CONFIG_INVALID', 'PROFILE_CONFLICT', 'SETTINGS_CORRUPT', 'TOKEN_REQUIRED', 'DISCORD_AUTH', 'DISCORD_OFFLINE', 'DISCORD_FORBIDDEN', 'DISCORD_HTTP', 'DISCORD_RESPONSE_INVALID',
    'BOT_IDENTITY_MISMATCH', 'IDENTITY_PINNED', 'HOST_COMPATIBILITY_UNVERIFIED', 'RECEIVER_NOT_READY', 'COMMAND_REGISTRATION_UNKNOWN', 'SECRET_RETIRE_PENDING',
    'PROTECTED_API_UNAVAILABLE', 'PROTECTED_STORE_UNSAFE_PATH', 'PROTECTED_LOGGING_POLICY', 'PROTECTED_STORE_FAILURE', 'PROTECTED_PAYLOAD_API_UNAVAILABLE', 'PROTECTED_PAYLOAD_UNSAFE_PATH', 'PROTECTED_PAYLOAD_LOGGING_POLICY', 'PROTECTED_PAYLOAD_FAILURE', 'INVALID_PAYLOAD_PATH', 'INVALID_SECRET_PATH', 'DB_UNAVAILABLE', 'DB_VERSION', 'DB_CORRUPT', 'DSH_PROTOCOL', 'DSH_REMOTE_ERROR']);
  return known.has(error?.code) ? error.code : 'HOST_OPERATION_FAILED';
}
function awaitAbortable(operation, signal) {
  if (signal?.aborted) return Promise.reject(new HostError('RECEIVER_NOT_READY'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => { if (settled) return; settled = true; cleanup(); reject(new HostError('RECEIVER_NOT_READY')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(value => {
      if (settled) return; settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) return; settled = true; cleanup(); reject(error);
    });
  });
}
/** Connected, restricted Host runtime. Internals are constructor-only test seams, never RPC inputs. */
export class DiscordHost {
  constructor(ctx, config = {}, internals = {}) {
    this.ctx = ctx; this.internals = internals;
    this.state = 'unconfigured'; this.lastError = ''; this.disposed = false; this.busy = false; this.bot = undefined; this.store = undefined; this.startGeneration = 0;
    this.settingsState = { profile, revision: 0, settings: null, secretRef: null, bot: null, retireRefs: [] };
    this.nativeAbort = new AbortController(); this.lifecycleAbort = new AbortController(); this.compactAbort = new AbortController(); this.compactEngineAbort = new AbortController(); this.compactServices = undefined;
    try {
      keys(config, ['dataRoot']);
      const root = config.dataRoot ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSHDiscordRemoteAgents', profile) : undefined);
      if (typeof root !== 'string' || !isAbsolute(root) || root.length > 1024 || /[\0\r\n]/.test(root)) fail('DATA_ROOT_REQUIRED');
      this.dataRoot = root;
      if (typeof ctx?.connection?.fetch?.register !== 'function' || !ctx?.sessionController || ['list', 'create', 'projections', 'page', 'prompt'].some(name => typeof ctx.sessionController[name] !== 'function')) fail('HOST_COMPATIBILITY_UNVERIFIED');
      this.compatible = true;
    } catch (error) { this.compatible = false; this.state = 'blocked'; this.lastError = safeCode(error); }
  }
  invalidateCompactLifecycle() {
    this.compactAbort?.abort();
    this.adapter?.invalidateCompactTargets();
    if (!this.disposed) this.compactAbort = new AbortController();
  }
  invalidateCompactEngine() {
    this.compactEngineAbort?.abort();
    if (!this.disposed) this.compactEngineAbort = new AbortController();
  }
  attachCompactServices(commands, agents) {
    this.invalidateCompactLifecycle();
    this.compactServices = commands && agents ? { commands, agents } : undefined;
    if (this.adapter) this.adapter.attachCompactServices(commands, agents);
    return this.adapter ? this.adapter.commands !== undefined : !!(commands && agents);
  }
  async initialize() {
    if (this.disposed) fail('DISPOSED');
    if (!this.compatible) fail(this.lastError || 'HOST_COMPATIBILITY_UNVERIFIED');
    if (this.store) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const metadataRoot = join(this.dataRoot, 'metadata');
      const prepare = this.internals.prepareRoot ?? prepareAdmissionJournalRoot;
      await prepare(metadataRoot);
      const store = this.internals.openStore ? await this.internals.openStore(metadataRoot) : new Store(join(metadataRoot, 'admission-journal.sqlite'), true);
      try {
        const marker = store.setting('restricted-storage-profile');
        if (marker && marker !== profile || !marker && store.allRuns().length) fail('PROFILE_CONFLICT');
        store.setSetting('restricted-storage-profile', profile);
        const raw = store.setting(stateKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!record(parsed) || parsed.profile !== profile || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || parsed.secretRef !== null && !isSecretRef(parsed.secretRef)
            || !Array.isArray(parsed.retireRefs) || !parsed.retireRefs.every(isSecretRef) || parsed.retireRefs.includes(parsed.secretRef)) fail('SETTINGS_CORRUPT');
          if (parsed.settings !== null) parsed.settings = validateSettings(parsed.settings);
          if (parsed.bot !== null && (!id(parsed.bot?.botId) || !id(parsed.bot?.applicationId) || typeof parsed.bot?.botName !== 'string')) fail('SETTINGS_CORRUPT');
          this.settingsState = parsed;
        }
        this.secretStore = this.internals.secretStore ?? new WindowsSecretStore(join(this.dataRoot, 'secrets'));
        this.protectedPayloadStore = this.internals.protectedPayloadStore ?? new WindowsProtectedPayloadStore(join(this.dataRoot, 'protected-output'));
        this.store = store;
        this.adapter = new NativeSessionAdapter(this.ctx.sessionController, store, this.nativeAbort.signal,
          this.compactServices?.commands, this.compactServices?.agents);
        this.state = this.settingsState.settings ? 'stopped' : 'unconfigured';
        store.recoverDispatches();
        await this.retireOldSecrets();
      } catch (error) { if (this.store !== store) store.close(); else { this.store = undefined; store.close(); } throw error; }
    })();
    try { await this.initializing; } finally { this.initializing = undefined; }
  }
  async retireOldSecrets() {
    const pending = this.settingsState.retireRefs;
    if (!pending.length) return;
    try { for (const ref of pending) await this.secretStore.retire(ref); }
    catch { this.lastError = 'SECRET_RETIRE_PENDING'; return; }
    const next = { ...this.settingsState, retireRefs: [] };
    this.writeState(next); this.lastError = '';
  }
  writeState(next) {
    const previous = this.store.setting(stateKey);
    if (!this.store.compareSetting(stateKey, previous, JSON.stringify(next))) fail('REVISION_CONFLICT');
    this.settingsState = next;
  }
  status() {
    const runs = this.store?.allRuns() ?? [];
    const state = this.disposed ? 'disposed' : this.bot && this.bot.client?.isReady && !this.bot.client.isReady() ? 'connecting' : this.state;
    return { profile, revision: this.settingsState.revision, state, tokenConfigured: this.settingsState.secretRef !== null,
      ...(this.settingsState.bot ? { botId: this.settingsState.bot.botId, botName: this.settingsState.bot.botName } : {}),
      settings: this.settingsState.settings ? structuredClone(this.settingsState.settings) : null,
      capabilities: this.compatible && this.nativeVerified ? capabilities : emptyCapabilities,
      activeRuns: runs.filter(run => ['dispatching', 'accepted', 'running', 'unknown'].includes(run.state)).length,
      unknownRuns: runs.filter(run => run.state === 'unknown').length,
      pendingNotifications: runs.filter(run => run.notification === 'pending').length,
      unknownNotifications: runs.filter(run => run.notification === 'unknown').length,
      ...(this.lastError || this.connectionNoticeFailed ? { lastError: this.lastError || 'CONNECTION_NOTICE_UNCONFIRMED' } : {}) };
  }
  dispatch(input, signal = this.lifecycleAbort.signal) {
    const task = this.runDispatch(input, AbortSignal.any([signal, this.lifecycleAbort.signal]));
    this.inFlight ??= new Set(); this.inFlight.add(task);
    task.finally(() => this.inFlight.delete(task));
    return task;
  }
  async runDispatch(input, signal) {
    try {
      const request = validateManagementRequest(input);
      if (this.disposed) fail('DISPOSED');
      if (this.busy && request.operation !== 'status') fail('MANAGEMENT_BUSY');
      if (request.operation === 'status') {
        if (!this.busy) try { await this.initialize(); } catch (error) { this.state = 'blocked'; this.lastError = safeCode(error); }
        return { ok: true, value: this.status() };
      }
      this.busy = true;
      try {
        await this.initialize(); signal.throwIfAborted();
        if (request.expectedRevision !== undefined && request.expectedRevision !== this.settingsState.revision) fail('REVISION_CONFLICT');
        if (request.operation === 'test') {
          const candidate = request.token ? token(request.token) : await this.readToken();
          const bot = await validateBot(candidate, this.internals.fetcher ?? fetch, signal);
          return { ok: true, value: { botId: bot.botId, botName: bot.botName } };
        }
        switch (request.operation) {
          case 'save': await this.save(request, signal); break;
          case 'start': await this.start(signal); this.confirmAutoStart(); break;
          case 'stop': this.store.setSetting('restricted-auto-start-confirmed', ''); await this.stop(); break;
          case 'reconnect': await this.stop(); await this.start(signal); this.confirmAutoStart(); break;
          case 'deleteSecret': await this.deleteSecret(); break;
          case 'registerCommands': await this.registerCommands(signal); break;
        }
        this.lastError = this.settingsState.retireRefs.length ? 'SECRET_RETIRE_PENDING' : ''; return { ok: true, value: this.status() };
      } finally { this.busy = false; }
    } catch (error) { const code = safeCode(error); this.lastError = code; return { ok: false, code }; }
  }
  async readToken() {
    if (!this.settingsState.secretRef) fail('TOKEN_REQUIRED');
    return token(await this.secretStore.read(this.settingsState.secretRef));
  }
  async save(request, signal) {
    const settings = validateSettings(request.settings);
    // Validate real, existing allowlist directories before persisting any new configuration.
    await Policy.create(productConfig(settings, '', ''));
    const old = this.settingsState;
    if (this.store.allRuns().length && old.settings && (settings.applicationId !== old.settings.applicationId || settings.guildId !== old.settings.guildId)) fail('IDENTITY_PINNED');
    const candidate = request.token ? token(request.token) : await this.readToken();
    const bot = await validateBot(candidate, this.internals.fetcher ?? fetch, signal);
    if (bot.applicationId !== settings.applicationId || old.bot && this.store.allRuns().length && bot.botId !== old.bot.botId) fail('BOT_IDENTITY_MISMATCH');
    signal.throwIfAborted();
    await this.stop();
    let nextRef = old.secretRef;
    if (request.token) nextRef = await this.secretStore.create(candidate);
    const next = { profile, revision: old.revision + 1, settings, secretRef: nextRef, bot,
      retireRefs: [...old.retireRefs, ...(old.secretRef && nextRef !== old.secretRef ? [old.secretRef] : [])] };
    try { this.writeState(next); }
    catch (error) { if (nextRef !== old.secretRef) try { await this.secretStore.retire(nextRef); } catch {} throw error; }
    this.store.setSetting('restricted-auto-start-confirmed', '');
    this.state = 'stopped'; await this.retireOldSecrets();
    // Save never starts a receiver, even if autoStart was selected.
  }
  async deleteSecret() {
    // Pending work remains pinned and cannot be moved to a different Bot on next save.
    await this.stop();
    const old = this.settingsState;
    const next = { ...old, revision: old.revision + 1, secretRef: null, retireRefs: [...old.retireRefs, ...(old.secretRef ? [old.secretRef] : [])] };
    this.writeState(next); this.store.setSetting('restricted-auto-start-confirmed', '');
    await this.retireOldSecrets(); this.state = 'stopped';
  }
  confirmAutoStart() {
    this.store.setSetting('restricted-auto-start-confirmed', this.settingsState.settings?.autoStart ? String(this.settingsState.revision) : '');
  }
  boot() {
    const task = this.runBoot(); this.inFlight ??= new Set(); this.inFlight.add(task);
    task.finally(() => this.inFlight.delete(task)); return task;
  }
  async runBoot() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      await this.initialize();
      if (!this.disposed && this.settingsState.settings?.autoStart && this.store.setting('restricted-auto-start-confirmed') === String(this.settingsState.revision)) {
        await this.start();
      }
    } catch (error) {
      if (!this.disposed) { const code = safeCode(error); if (code === 'RECEIVER_NOT_READY') this.state = 'stopped'; else { this.state = 'blocked'; this.lastError = code; } }
    }
    finally { this.busy = false; }
  }
  async start(signal = this.lifecycleAbort.signal) {
    if (this.disposed) fail('DISPOSED');
    if (this.bot?.client?.isReady?.()) return;
    this.invalidateCompactLifecycle();
    if (this.bot) await this.stop();
    if (this.disposed || signal.aborted) fail('RECEIVER_NOT_READY');
    const generation = ++this.startGeneration;
    const ensureCurrent = () => { if (this.disposed || signal.aborted || generation !== this.startGeneration) fail('RECEIVER_NOT_READY'); };
    const settingsState = this.settingsState, settings = settingsState.settings; if (!settings) fail('SETTINGS_INVALID');
    const candidate = await awaitAbortable(this.readToken(), signal); ensureCurrent();
    const botIdentity = await validateBot(candidate, this.internals.fetcher ?? fetch, signal); ensureCurrent();
    if (botIdentity.applicationId !== settings.applicationId || settingsState.bot?.botId !== botIdentity.botId || this.settingsState !== settingsState) fail('BOT_IDENTITY_MISMATCH');
    const config = productConfig(settings, candidate, '');
    const policy = await awaitAbortable(Policy.create(config), signal); ensureCurrent();
    // Availability/protocol validation before advertising or starting native text capabilities.
    await awaitAbortable(this.adapter.list(), signal); ensureCurrent(); this.nativeVerified = true;
    // Freeze the Host generation, but compose the current optional-service epoch per operation.
    const engineLifetimeSignal = this.compactEngineAbort.signal;
    const engineCompactSignal = () => AbortSignal.any([engineLifetimeSignal, this.compactAbort.signal]);
    const engine = new Engine(this.adapter, this.store, policy, [candidate], true, this.protectedPayloadStore, { applicationId: settings.applicationId, botId: botIdentity.botId }, true, engineCompactSignal);
    engine.registerWorkspace = async (actor, alias, path, confirmed) => {
      policy.authorize(actor.userId, actor.guildId, actor.channelId);
      if (!confirmed) fail('CONFIRMATION_REQUIRED');
      if (this.busy || this.disposed || this.engine !== engine) fail('MANAGEMENT_BUSY');
      this.busy = true;
      const previous = this.settingsState;
      try {
        const previousBytes = this.store.setting(stateKey);
        await policy.addWorkspace(alias, path, actor.guildId, () => {
          policy.authorize(actor.userId, actor.guildId, actor.channelId);
          if (this.disposed || this.engine !== engine || this.settingsState !== previous) fail('REVISION_CONFLICT');
          const settings = validateSettings({ ...previous.settings, workspaces: { ...previous.settings.workspaces, [alias]: path } });
          const next = { ...previous, revision: previous.revision + 1, settings };
          if (!Number.isSafeInteger(next.revision) || next.revision >= Number.MAX_SAFE_INTEGER - 10) fail('REVISION_CONFLICT');
          if (!this.store.compareSetting(stateKey, previousBytes, JSON.stringify(next))) fail('REVISION_CONFLICT');
          this.settingsState = next;
        });
      } finally { this.busy = false; }
    };
    ensureCurrent();
    const bot = this.internals.createBot ? this.internals.createBot(config, engine) : new DiscordBot(config, engine, undefined, true);
    ensureCurrent(); this.state = 'connecting'; this.bot = bot; this.engine = engine;
    try {
      ensureCurrent(); await bot.start(); ensureCurrent();
      if (bot.client?.isReady && !bot.client.isReady()) fail('RECEIVER_NOT_READY');
      this.state = 'connected';
    } catch (error) {
      await bot.stop().catch(() => {});
      if (this.bot === bot) this.bot = undefined;
      if (this.engine === engine) { this.engine = undefined; this.invalidateCompactEngine(); this.invalidateCompactLifecycle(); }
      this.state = this.disposed ? 'disposed' : 'stopped'; throw error;
    }
    // Message failure is not a failed connection and must never trigger reconnect/prompt replay.
    this.connectionNoticeFailed = false;
    if (typeof bot.notifyConnected === 'function') {
      try {
        // A slow/blocked DM must not hold the management RPC or make a ready receiver look failed.
        Promise.resolve(bot.notifyConnected()).then(result => {
          if (!this.disposed && this.bot === bot) this.connectionNoticeFailed = result?.failed !== 0;
        }, () => { if (!this.disposed && this.bot === bot) this.connectionNoticeFailed = true; });
      } catch { this.connectionNoticeFailed = true; }
    }
  }
  async stop() {
    this.invalidateCompactEngine(); this.invalidateCompactLifecycle();
    this.startGeneration++;
    const bot = this.bot;
    if (bot) { await bot.stop(); this.bot = undefined; this.engine = undefined; }
    this.state = this.settingsState.settings ? 'stopped' : 'unconfigured';
  }
  async registerCommands(signal) {
    const settings = this.settingsState.settings; if (!settings) fail('SETTINGS_INVALID');
    const candidate = await this.readToken();
    const bot = await validateBot(candidate, this.internals.fetcher ?? fetch, signal);
    if (bot.applicationId !== settings.applicationId || bot.botId !== this.settingsState.bot?.botId) fail('BOT_IDENTITY_MISMATCH');
    const definition = command.toJSON();
    const bind = definition.options?.find(option => option.name === 'bind'); if (bind) bind.description = '既存セッションをこのチャンネルの共有先に選択';
    try { await discordRequest(this.internals.fetcher ?? fetch, candidate, `/applications/${settings.applicationId}/guilds/${settings.guildId}/commands`, { method: 'PUT', body: JSON.stringify([definition]) }, signal); }
    catch { fail('COMMAND_REGISTRATION_UNKNOWN'); }
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true; this.startGeneration++; this.lifecycleAbort.abort(); this.attachCompactServices(undefined, undefined);
    // Await our in-flight management operation only; never cancel native Session agents.
    await Promise.allSettled([...(this.inFlight ?? [])]);
    await this.stop(); this.nativeAbort.abort();
    await this.initializing?.catch(() => {});
    this.store?.close(); this.store = undefined; this.state = 'disposed';
  }
}
