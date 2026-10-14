import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startHarness } from './helpers/app-harness.mjs';
import { withEnvFile } from './helpers/gemini-env.mjs';
import { wsUrl, GeminiError } from '../server/gemini-live.mjs';

const KEY = 'AIz\u0061SyFAKEKEYFORAPITEST0123456789ab';
const TOKEN = 'auth_tokens/APITESTTOKENvalue0123456789abcdefghijklmnopqrstuvwxyz0123456789';
const ENV = `GEMINI_API_KEY=${KEY}\n`;
const NOES = (voice) => ({ es: { noEs: true, company: '', industry: '', role: '', mode: 'first' }, ...(voice ? { voice } : {}) });

/** 偽のトークン発行。プロンプトを記録する。 */
function fakeIssuer() {
  const calls = [];
  return { calls, issue: async ({ prompt }) => { calls.push(prompt); return { token: TOKEN }; } };
}

/** 全ファイルを読み、キーとトークンが残っていないか調べる。 */
async function leaks(dir) {
  const hits = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      const text = await readFile(p, 'utf8');
      if (text.includes(KEY) || text.includes(TOKEN) || text.includes('auth_tokens/')) hits.push(p);
    }
  };
  await walk(dir);
  return hits;
}

test('Gemini: 設定が無いと選べない（config は available:false、作成は400）。いつもの声は影響なし', async () => {
  const prev = process.env.GEMINI_ENV_FILE;
  delete process.env.GEMINI_ENV_FILE;
  const h = await startHarness();
  try {
    const c = h.client();
    const cfg = await (await c.get('/api/config')).json();
    assert.deepEqual(cfg.voices.map((v) => [v.id, v.available]), [['codex', true], ['gemini', false]]);
    assert.equal((await c.post('/api/sessions', NOES('gemini'))).status, 400);
    assert.equal((await c.post('/api/sessions', NOES('openai'))).status, 400);
    const ok = await c.post('/api/sessions', NOES());
    assert.equal(ok.status, 200);
    const { id } = await ok.json();
    assert.equal((await (await c.get(`/api/sessions/${id}`)).json()).voice, 'codex');
    assert.equal((await c.post(`/api/sessions/${id}/gemini`, {})).status, 409); // 声が codex の面接では使えない
  } finally {
    await h.cleanup();
    if (prev !== undefined) process.env.GEMINI_ENV_FILE = prev;
  }
});

test('Gemini: トークンを発行して返す。キー本体は返さず、保存もしない。字幕は逐語録・字幕・採点・無料枠に流れる', async () => {
  await withEnvFile(ENV, async () => {
    const iss = fakeIssuer();
    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.join(' ')); };
    const h = await startHarness({ issueVoiceToken: iss.issue });
    try {
      const { cookie } = await h.newDevice();
      const c = h.client(cookie);
      const cfg = await (await c.get('/api/config')).json();
      assert.equal(cfg.voices.find((v) => v.id === 'gemini').available, true);
      const { id } = await (await c.post('/api/sessions', NOES('gemini'))).json();
      const list = await (await c.get('/api/sessions')).json();
      assert.equal(list.find((s) => s.id === id).voice, 'gemini');

      // 声が gemini の面接は Codex の経路では始められない
      assert.equal((await c.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' })).status, 409);

      const start = await c.post(`/api/sessions/${id}/gemini`, {});
      assert.equal(start.status, 200);
      const text = await start.text();
      const out = JSON.parse(text);
      assert.equal(out.url, wsUrl(TOKEN));
      assert.ok(!text.includes(KEY), 'キー本体は返さない');
      assert.equal(out.model, 'gemini-3.8-live');
      assert.match(out.kickoffText, /応募者が入室し/);
      assert.ok(iss.calls[0].includes('面接官'), '面接官プロンプトでトークンを作る');
      assert.ok(!text.includes(iss.calls[0].slice(0, 30)), '面接官プロンプトはブラウザへ返さない');
      assert.equal((await (await c.get(`/api/sessions/${id}`)).json()).status, 'interviewing');

      // 字幕を送る（ready の合図つき）。深掘りの往復が採点まで流れる
      const post = (body) => c.post(`/api/sessions/${id}/voice`, body);
      assert.equal((await post({ ready: true, events: [] })).status, 200);
      const say = (role, text) => post({ events: [{ role, kind: 'delta', text: text.slice(0, 3) }, { role, kind: 'delta', text: text.slice(3) }, { role, kind: 'done', text }] });
      await say('assistant', 'まず自己紹介をお願いします。');
      await say('user', '私は大学で統計を学び、ゼミで売上予測のモデルを作りました。');
      await say('assistant', 'その中で、あなた自身は何を担当しましたか。');
      await say('user', '特徴量の設計と検証を担当し、誤差を二割減らしました。');
      assert.equal((await post({ events: [{ role: 'system', kind: 'delta', text: 'x' }] })).status, 400);
      assert.equal((await post({ events: 'no' })).status, 400);

      assert.equal((await c.post(`/api/sessions/${id}/end`, {})).status, 200);
      const done = await h.wait(c, id, (s) => s.status === 'done' || s.status === 'error');
      assert.equal(done.status, 'done', done.error);
      assert.deepEqual(done.transcript.turns.map((t) => t.role), ['interviewer', 'candidate', 'interviewer', 'candidate']);
      assert.equal(done.transcript.turns[1].text, '私は大学で統計を学び、ゼミで売上予測のモデルを作りました。');
      assert.ok(h.calls.some((a) => a.kind === 'q-score'), '1問ごとの採点が走る');
      assert.equal(done.report.scoring.axes.length, 6);
      assert.equal((await (await c.get('/api/quota')).json()).used, 1, 'Gemini の面接も1回に数える');
      assert.deepEqual(await leaks(h.dir), []);
      assert.ok(!logs.join('\n').match(/AIz\u0061Sy|auth_tokens/), 'ログにキーもトークンも出ない');
    } finally {
      Object.assign(console, orig);
      await h.cleanup();
    }
  });
});

test('Gemini: 無料枠の上限では断る。発行に失敗したら元の状態へ戻し、文面にキーを出さない。abort で戻せる', async () => {
  await withEnvFile(ENV, async () => {
    let fail = true;
    const h = await startHarness({ issueVoiceToken: async () => { if (fail) throw new GeminiError('トークンの発行が拒否された (HTTP 403): [伏せ字]'); return { token: TOKEN }; } });
    try {
      const { cookie } = await h.newDevice();
      const c = h.client(cookie);
      const { id } = await (await c.post('/api/sessions', NOES('gemini'))).json();
      const bad = await c.post(`/api/sessions/${id}/gemini`, {});
      assert.equal(bad.status, 502);
      const err = await bad.text();
      assert.ok(!err.includes(KEY) && !err.includes('auth_tokens/'));
      assert.equal((await (await c.get(`/api/sessions/${id}`)).json()).status, 'ready'); // 戻っている
      fail = false;
      assert.equal((await c.post(`/api/sessions/${id}/gemini`, {})).status, 200);
      assert.equal((await c.post(`/api/sessions/${id}/gemini/abort`, {})).status, 200); // 話す前なら戻せる
      assert.equal((await (await c.get(`/api/sessions/${id}`)).json()).status, 'ready');
      assert.equal((await c.post(`/api/sessions/${id}/voice`, { events: [] })).status, 409); // 進行中ではない
      // 話し始めたあとは戻せない
      assert.equal((await c.post(`/api/sessions/${id}/gemini`, {})).status, 200);
      await c.post(`/api/sessions/${id}/voice`, { events: [{ role: 'assistant', kind: 'done', text: 'こんにちは。' }] });
      assert.equal((await c.post(`/api/sessions/${id}/gemini/abort`, {})).status, 409);
      await c.post(`/api/sessions/${id}/voice`, { events: [{ role: 'user', kind: 'done', text: 'よろしくお願いします。' }] });
      assert.equal((await c.post(`/api/sessions/${id}/end`, {})).status, 200);
      await h.wait(c, id, (s) => s.status === 'done' || s.status === 'error');
      // 無料枠 1 回を使い切ったので、次の Gemini の面接は 402
      const second = await (await c.post('/api/sessions', NOES('gemini'))).json();
      const refused = await c.post(`/api/sessions/${second.id}/gemini`, {});
      assert.equal(refused.status, 402);
    } finally { await h.cleanup(); }
  });
});
