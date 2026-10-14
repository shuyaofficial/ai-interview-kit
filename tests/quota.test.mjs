import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadQuotaConfig, createQuotaStore, createQuota, parseCookies, deviceCookie, isSecure, DEVICE_RE } from '../server/quota.mjs';
import { startHarness } from './helpers/app-harness.mjs';

const strong = JSON.parse(readFileSync(new URL('../fixtures/strong-transcript.json', import.meta.url), 'utf8'));
const NOES = { es: { noEs: true, company: '', industry: '', role: '', mode: 'first' } };
const GYM = { consent: true, type: 'logic', level: 'warmup', anxiety: [1, 1, 1, 1, 1, 1], quick: {} };

/** セッションを作って音声を始め、turns を話して終える。 */
async function runInterview(h, c, turns, { path = '/api/sessions', body = NOES } = {}) {
  const { id } = await (await c.post(path, body)).json();
  const start = await c.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' });
  if (start.status !== 200) return { id, start };
  h.say(turns);
  const end = await c.post(`/api/sessions/${id}/${path === '/api/gym/sessions' ? 'stop' : 'end'}`, {});
  return { id, start, end };
}
const quota = async (c) => (await c.get('/api/quota')).json();

test('設定: quota.json は freeInterviews:1。QUOTA_DISABLED=1 で無効', () => {
  const file = fileURLToPath(new URL('../server/quota.json', import.meta.url));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { freeInterviews: 1 });
  assert.deepEqual(loadQuotaConfig({ file, env: {} }), { freeInterviews: 1, enabled: true });
  assert.equal(loadQuotaConfig({ file, env: { QUOTA_DISABLED: '1' } }).enabled, false);
  assert.equal(loadQuotaConfig({ file: '/nonexistent.json', env: {} }).freeInterviews, 1);
});

test('Cookie: 初回に乱数の端末 ID を HttpOnly・SameSite=Strict で発行し、2回目以降は再発行しない（http では Secure なし）', async () => {
  const h = await startHarness();
  try {
    const first = await h.client().get('/api/quota');
    const set = first.headers.get('set-cookie');
    assert.match(set, /^iv_device=[a-f0-9]{32}; /);
    assert.match(set, /; HttpOnly/);
    assert.match(set, /; SameSite=Strict/);
    assert.match(set, /; Path=\//);
    assert.doesNotMatch(set, /Secure/);
    const cookie = set.split(';')[0];
    assert.equal((await h.client(cookie).get('/api/quota')).headers.get('set-cookie'), null);
    const other = (await h.client().get('/api/quota')).headers.get('set-cookie').split(';')[0];
    assert.notEqual(other, cookie); // 乱数
    // 形が不正な cookie は無視して新しく発行する
    assert.match((await h.client('iv_device=../../etc').get('/api/quota')).headers.get('set-cookie'), /^iv_device=[a-f0-9]{32}/);
  } finally { await h.cleanup(); }
});

test('Cookie: https 経由（x-forwarded-proto・外部ホスト名）のときだけ Secure が付く', () => {
  assert.equal(isSecure({ headers: { host: '127.0.0.1:8979' } }), false);
  assert.equal(isSecure({ headers: { host: 'localhost:8979' } }), false);
  assert.equal(isSecure({ headers: { host: '127.0.0.1:8979', 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isSecure({ headers: { host: 'my-pc.example.ts.net:8979' } }), true);
  const id = 'a'.repeat(32);
  assert.match(deviceCookie(id, true), /; Secure$/);
  assert.deepEqual(parseCookies('a=1; iv_device=abc; b=x=y'), { a: '1', iv_device: 'abc', b: 'x=y' });
  assert.ok(DEVICE_RE.test(id));
});

test('数え方: 応募者の発言がある音声セッションの終了で1回。2回目を始めようとするとアンケート、回答後はプランで断る（コード付き）', async () => {
  const h = await startHarness();
  try {
    const { cookie } = await h.newDevice();
    const c = h.client(cookie);
    assert.deepEqual(await quota(c), { enabled: true, free: 1, used: 0, remaining: 1, surveyDone: false, exhausted: false, next: 'ok' });
    const r1 = await runInterview(h, c, strong.turns.slice(0, 4));
    assert.equal(r1.end.status, 200);
    assert.deepEqual(await quota(c), { enabled: true, free: 1, used: 1, remaining: 0, surveyDone: false, exhausted: true, next: 'survey' });
    // 2回目: 音声セッションの開始がサーバーで断られる
    const { id } = await (await c.post('/api/sessions', NOES)).json();
    const refused = await c.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' });
    assert.equal(refused.status, 402);
    const body = await refused.json();
    assert.equal(body.code, 'quota_survey');
    assert.equal(h.prompts.length, 1); // 2本目の音声は始まっていない
    // アンケートに答えると、断りのコードがプランに変わる
    const fb = await c.post('/api/feedback', { rating: 4, sendToDev: false });
    assert.equal(fb.status, 200);
    assert.equal((await quota(c)).next, 'plan');
    const again = await c.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' });
    assert.equal(again.status, 402);
    assert.equal((await again.json()).code, 'quota_plan');
    // 別の端末の枠は別
    const other = h.client((await h.newDevice()).cookie);
    assert.equal((await quota(other)).next, 'ok');
  } finally { await h.cleanup(); }
});

test('数え方: ジム（止める）も数える。同じ端末のデータは data/quota/<端末ID>.json に { used, sessions, surveyDoneAt } だけ', async () => {
  const h = await startHarness();
  try {
    const { cookie } = await h.newDevice();
    const c = h.client(cookie);
    const r = await runInterview(h, c, strong.turns.slice(0, 2), { path: '/api/gym/sessions', body: GYM });
    assert.equal(r.end.status, 200);
    assert.equal((await quota(c)).used, 1);
    const files = await readdir(join(h.dir, 'quota'));
    assert.deepEqual(files, [`${cookie.split('=')[1]}.json`]);
    const saved = JSON.parse(await readFile(join(h.dir, 'quota', files[0]), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['bonus', 'sessions', 'surveyDoneAt', 'used']);
    assert.equal(saved.sessions.length, 1);
    assert.equal(saved.sessions[0].id, r.id);
    assert.equal((await c.post('/api/gym/sessions', GYM)).status, 200); // セッションを作るだけなら止まらない
  } finally { await h.cleanup(); }
});

test('数えない: 応募者が何も話していない・接続に失敗した・ES 添削・ES 読み取りは数えない', async () => {
  const h = await startHarness();
  try {
    const { cookie } = await h.newDevice();
    const c = h.client(cookie);
    const silent = await runInterview(h, c, [strong.turns[0]]); // 面接官の発言だけ
    assert.equal(silent.end.status, 200);
    assert.equal((await quota(c)).used, 0);
    // ES 添削（旧形式 ES のセッション作成）
    const weak = JSON.parse(readFileSync(new URL('../fixtures/weak-transcript.json', import.meta.url), 'utf8'));
    await c.post('/api/sessions', { es: weak.es });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await quota(c)).used, 0);
    assert.equal((await quota(c)).next, 'ok');
  } finally { await h.cleanup(); }
  const bad = await startHarness({ failConnect: true });
  try {
    const { cookie } = await bad.newDevice();
    const c = bad.client(cookie);
    const r = await runInterview(bad, c, strong.turns.slice(0, 2));
    assert.equal(r.start.status, 502); // 接続に失敗
    assert.equal((await quota(c)).used, 0);
  } finally { await bad.cleanup(); }
});

test('無効化: QUOTA_DISABLED 相当なら何回でも始められ、数えない', async () => {
  const h = await startHarness({ quota: { enabled: false } });
  try {
    const c = h.client((await h.newDevice()).cookie);
    for (let i = 0; i < 2; i += 1) assert.equal((await runInterview(h, c, strong.turns.slice(0, 2))).start.status, 200);
    const q = await quota(c);
    assert.equal(q.used, 0);
    assert.equal(q.next, 'ok');
    assert.equal(q.enabled, false);
  } finally { await h.cleanup(); }
});

test('ストア: 同じセッションは1回だけ数える。grant で枠が増え、reset で戻り、list に出る。不正な端末IDは拒否', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-quota-'));
  try {
    const store = createQuotaStore(dir);
    const q = createQuota({ dir, config: { freeInterviews: 1, enabled: true } });
    const id = 'b'.repeat(32);
    await store.record(id, 's1');
    await store.record(id, 's1');
    assert.equal((await store.read(id)).used, 1);
    assert.equal((await q.view(id)).next, 'survey');
    await store.grant(id, 2);
    assert.deepEqual([(await q.view(id)).remaining, (await q.view(id)).next], [2, 'ok']);
    await store.markSurvey(id);
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.list())[0].device, id);
    await store.record(id, 's2');
    await store.record(id, 's3');
    await assert.rejects(() => q.assertCanStart(id), (e) => e.status === 402 && e.code === 'quota_plan');
    assert.deepEqual(await store.reset(id), [id]);
    assert.deepEqual(await store.list(), []);
    assert.equal((await q.view(id)).next, 'ok');
    await assert.rejects(() => store.read('../x'), /端末ID/);
    await store.record(id, 's9');
    await store.record('c'.repeat(32), 's3');
    assert.equal((await store.reset(null)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
