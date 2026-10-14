import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { makeLlm } from './helpers/app-harness.mjs';

// REALTIME_MODEL があれば bridge.startRealtime に model を渡し、無ければ model のキーごと渡さない
async function startWith(envModel) {
  const prev = process.env.REALTIME_MODEL;
  if (envModel === undefined) delete process.env.REALTIME_MODEL; else process.env.REALTIME_MODEL = envModel;
  const seen = [];
  const bridge = { startRealtime: async (a) => { seen.push(a); return { threadId: 't1', answer: 'v=0 fake' }; }, stopRealtime: async () => {}, appendText: async () => {}, close: () => {} };
  const dir = await mkdtemp(join(tmpdir(), 'ai-interview-rtm-'));
  const app = createApp({ bridge, llm: makeLlm([]), dataDir: dir, quota: { freeInterviews: 1, enabled: false } });
  await app.init();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const json = { 'content-type': 'application/json' };
  try {
    const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ es: { noEs: true, mode: 'first' } }) })).json();
    const res = await fetch(`${base}/api/sessions/${id}/realtime`, { method: 'POST', headers: json, body: JSON.stringify({ sdp: 'v=0 x' }) });
    assert.equal(res.status, 200);
    return seen[0];
  } finally {
    if (prev === undefined) delete process.env.REALTIME_MODEL; else process.env.REALTIME_MODEL = prev;
    await app.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('REALTIME_MODEL を設定すると startRealtime に model を渡す', async () => {
  assert.equal((await startWith('gpt-realtime-2.1')).model, 'gpt-realtime-2.1');
});

test('REALTIME_MODEL が未設定なら model を渡さない（従来どおり）', async () => {
  const args = await startWith(undefined);
  assert.ok(!('model' in args));
});
