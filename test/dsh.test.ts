import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DshAdapter, DshRejected, object } from '../src/dsh.js';
interface Call { method: string; request: Record<string, unknown> }
async function serve(t: { after: (fn: () => unknown) => void }, reply: (call: Call) => unknown) {
  const calls: Call[] = []; let logins = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === '/?token=test-token') { logins++; res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fake=abc; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return; }
      if (req.headers.cookie !== 'dsh-auth-fake=abc') { res.writeHead(401); res.end('Unauthorized'); return; }
      assert.equal(req.method, 'POST');
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(payload.kind, 'invoke');
      const call = { method: req.url?.split('/').at(-1) ?? '', request: object(object(payload.args).request) };
      calls.push(call);
      const value = reply(call); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, value }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing server');
  return { adapter: new DshAdapter(`http://127.0.0.1:${address.port}`, 'test-token'), calls, logins: () => logins };
}
test('real HTTP cookie bootstrap, named args envelope, list/projections/create/prompt wire contract', async t => {
  const { adapter, calls, logins } = await serve(t, ({ method, request }) => {
    if (method === 'list') return { items: [{ sessionId: 'existing', cwd: 'C:\\project', running: false, updatedAt: 12, projections: { values: { title: 'title' } } }] };
    if (method === 'projections') return { asOfSeq: 7, values: { inbox: { 'next-turn': [], 'next-step': [] } } };
    if (method === 'create') return { sessionId: request.sessionId };
    if (method === 'prompt') { assert.equal(request.mode, 'queue'); assert.equal(request.requestId, 'discord:123'); assert.deepEqual(request.content, [{ type: 'text', text: 'hello' }]); return { accepted: true }; }
    throw new Error('unexpected method');
  });
  assert.equal((await adapter.list())[0]?.title, 'title'); assert.equal((await adapter.snapshot('existing')).cursor, 7);
  assert.match(await adapter.create('C:\\project'), /^discord-/); await adapter.prompt('existing', 'discord:123', 'hello');
  assert.equal(logins(), 1); assert.deepEqual(calls.map(c => c.method), ['list', 'projections', 'create', 'prompt']);
});
test('modelSelection projection distinguishes last-used from next and copies only bounded official fields', async t => {
  const { adapter } = await serve(t, ({ method }) => method === 'list' ? { items: [{ sessionId: 'existing', cwd: 'C:\\\\project', running: false, updatedAt: 1,
    projections: { values: { title: 'synthetic', modelSelection: { lastUsed: { provider: 'provider-a', model: 'model-used', reasoningEffort: 'high', secret: 'DROP' },
      next: { provider: 'provider-b', model: 'model-next', reasoningEffort: 'low' } } } } }] } : { items: [] });
  const session = (await adapter.list())[0]!;
  assert.deepEqual(session.lastUsedModel, { provider: 'provider-a', model: 'model-used', reasoningEffort: 'high' });
  assert.deepEqual(session.nextModel, { provider: 'provider-b', model: 'model-next', reasoningEffort: 'low' });
});

test('page walks backward with stable throughSeq, verifies contiguous stream then returns chronological suffix', async t => {
  const events = Array.from({ length: 6 }, (_, seq) => ({ type: 'example', seq, time: seq, data: {} }));
  const { adapter, calls } = await serve(t, ({ request }) => {
    assert.equal(request.throughSeq, 5); const end = typeof request.beforeSeq === 'number' ? request.beforeSeq : 6;
    const start = Math.max(0, end - 2); return { records: events.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 };
  });
  assert.deepEqual((await adapter.events('existing', 5, 0)).map(e => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.map(c => c.request.beforeSeq), [undefined, 4, 2]);
  await assert.rejects(adapter.events('existing', 1, 2), { code: 'DSH_LOG_CHANGED' });
});
test('gap/incompatible envelope fails rather than falsely declaring completion', async t => {
  const { adapter } = await serve(t, () => ({ records: [{ type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: {} } }], hasMore: false }));
  await assert.rejects(adapter.events('existing', 3, 0), { code: 'DSH_PROTOCOL' });
});
test('no root-token secret appears in thrown errors, unauthenticated redirects never followed', async () => {
  const fetcher = (async () => new Response('token should not be logged', { status: 401 })) as typeof fetch;
  const adapter = new DshAdapter('http://127.0.0.1:19387', 'sensitive-token', fetcher);
  await assert.rejects(adapter.list(), error => error instanceof DshRejected && !error.message.includes('sensitive-token'));
});
test('known remote preadmission rejection differs from ambiguous internal failure', async () => {
  const make = (code: string): typeof fetch => (async (input: unknown) => {
    if (String(input).includes('?token=')) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-fake=x' } });
    return new Response(JSON.stringify({ ok: false, error: { code, message: 'SECRET_RAW_ERROR' } }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(new DshAdapter('http://localhost:19387', 'x', make('session/writer-held')).prompt('s', 'r', 't'), error => error instanceof DshRejected && !error.message.includes('SECRET_RAW_ERROR'));
  await assert.rejects(new DshAdapter('http://localhost:19387', 'x', make('gateway/internal')).prompt('s', 'r', 't'), error => error instanceof Error && !(error instanceof DshRejected));
});
