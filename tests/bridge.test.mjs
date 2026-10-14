import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexBridge, APP_SERVER_ARGS } from '../server/codex-bridge.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-app-server.mjs', import.meta.url));
const quiet = { warn: () => {}, error: () => {} };
const make = (env = {}) => {
  process.env.FAKE_MODE = env.FAKE_MODE ?? 'normal';
  return new CodexBridge({ command: process.execPath, args: [FAKE], requestTimeoutMs: 2000, logger: quiet });
};

test('起動引数は本人の ~/.codex のフック・シェルを無効化する固定値', () => {
  assert.deepEqual(APP_SERVER_ARGS, ['app-server', '--disable', 'hooks', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'shell_snapshot', '-c', 'mcp_servers={}']);
});

test('runStructured: JSON を返し、想定外 item は警告ログ', async () => {
  const warnings = [];
  const b = new CodexBridge({ command: process.execPath, args: [FAKE], logger: { warn: (m) => warnings.push(m), error() {} } });
  try {
    const out = await b.runStructured({ prompt: 'hello', schema: { type: 'object' } });
    assert.deepEqual(out, { ok: true, prompt: 'hello' });
    assert.ok(warnings.some((w) => w.includes('commandExecution')));
  } finally { b.close(); }
});

test('サーバー→クライアント要求は拒否される', async () => {
  const b = make();
  const seen = [];
  b.subscribe((m) => seen.push(m.method));
  try {
    await b.request('ask-me-something', {});
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.includes('bridge/serverRequestRejected'));
  } finally { b.close(); }
});

test('子プロセスが死んだら pending は reject され、次の request で再起動する', async () => {
  const b = make({ FAKE_MODE: 'die-on-turn' });
  const exits = [];
  b.subscribe((m) => m.method === 'bridge/exit' && exits.push(m));
  try {
    await assert.rejects(b.runStructured({ prompt: 'x', schema: {} }), /app-server が終了した|bridge/);
    assert.equal(exits.length, 1);
    process.env.FAKE_MODE = 'normal';
    const started = await b.request('thread/start', {});
    assert.ok(started.thread.id);
  } finally { b.close(); }
});

test('応答が無い request はタイムアウトする', async () => {
  const b = make();
  try {
    await b.ensureStarted();
    await assert.rejects(b.request('no-reply', {}, { timeoutMs: 100 }), /timeout: no-reply/);
  } finally { b.close(); }
});

test('startRealtime: model を渡さなければ params に model を含めない（従来どおり）', async () => {
  const b = make();
  try {
    const { answer } = await b.startRealtime({ offerSdp: 'v=0 offer', prompt: 'p' });
    assert.match(answer, /model=none/);
    assert.ok(!/keys=.*\bmodel\b/.test(answer));
  } finally { b.close(); }
});

test('startRealtime: model を渡すと realtime/start の params に載る', async () => {
  const b = make();
  try {
    const { answer } = await b.startRealtime({ offerSdp: 'v=0 offer', prompt: 'p', model: 'gpt-realtime-2.1' });
    assert.match(answer, /model=gpt-realtime-2\.1 /);
    assert.match(answer, /keys=.*\bmodel\b/);
  } finally { b.close(); }
});

test('startRealtime: model が拒否されたらエラー文がそのまま出る', async () => {
  const b = make({ FAKE_MODE: 'reject-model' });
  try {
    await assert.rejects(b.startRealtime({ offerSdp: 'v=0 offer', prompt: 'p', model: 'bad-model' }), /unknown realtime model: bad-model/);
    assert.match((await b.startRealtime({ offerSdp: 'v=0 offer', prompt: 'p' })).answer, /model=none/);
  } finally { b.close(); }
});
