import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createApp } from '../server/index.mjs';

const fx = JSON.parse(readFileSync(new URL('../fixtures/weak-transcript.json', import.meta.url), 'utf8'));
const itemResult = { scores: { prep: 3, specificity: 2, length: 4 }, comments: [], rewrite: '書き直し' };
const planResult = { focusPoints: [{ topic: 't', why: 'w', probes: ['p'] }] };
const calls = [];
let failOnce = new Set(); // 一度だけ失敗させる設問の題
const fakeLlm = {
  plans: { default: 'standard', plans: { standard: { label: 'S' }, premium: { label: 'P' } } },
  expectedSec: (kind) => ({ 'es-item': 25 })[kind] ?? 30,
  expectedChars: () => null,
  runStructured: async (a) => {
    calls.push(a);
    if (a.kind === 'es-extract') return { company: 'テスト社', industry: 'IT', role: '開発', items: [{ title: '自己PR', limit: 400, text: 'あ'.repeat(120) }, { title: '志望動機', limit: 0, text: '本文' }] };
    if (a.kind === 'es-plan') return planResult;
    for (const t of failOnce) if (a.prompt.includes(`## ${t}`)) { failOnce.delete(t); throw new Error('boom'); }
    return itemResult;
  },
};
const fakeBridge = {
  startRealtime: async () => { throw new Error('not used'); },
  stopRealtime: async () => {},
  close: () => {},
};

let app;
let base;
let dataDir;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ai-interview-test-'));
  app = createApp({ bridge: fakeBridge, llm: fakeLlm, dataDir });
  await app.init();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

const json = { 'content-type': 'application/json' };
const post = (path, body, headers = json) => fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('不正な id は 400（パス走査を含む）', async () => {
  for (const id of ['a.b', 'a%2e%2e', 'a b', 'x'.repeat(65), 'あ']) {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`);
    assert.equal(res.status, 400, id);
  }
  assert.equal((await fetch(`${base}/api/sessions/..%2f..%2fetc`)).status, 400);
  assert.equal((await post('/api/sessions/bad.id/end', {})).status, 400);
  assert.equal((await post('/api/sessions/bad.id/realtime', { sdp: 'v=0' })).status, 400);
  assert.equal((await fetch(`${base}/api/sessions/bad.id/events`)).status, 400);
});

test('存在しない id は 404', async () => {
  assert.equal((await fetch(`${base}/api/sessions/nothing-here`)).status, 404);
});

test('es の検証: 欠落・型違い・2000字超は 400、本文 1MB 超は 413', async () => {
  assert.equal((await post('/api/sessions', { es: { ...fx.es, gakuchika: 5 } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { ...fx.es, role: '  ' } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { company: 'x' } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { ...fx.es, selfPr: 'あ'.repeat(2001) } })).status, 400);
  assert.equal((await post('/api/sessions', '{broken')).status, 400);
  assert.equal((await post('/api/sessions', 'x'.repeat(1024 * 1024 + 10))).status, 413);
});

test('POST に content-type: application/json が無ければ 415、Host/Origin 不正は 403', async () => {
  assert.equal((await post('/api/sessions', { es: fx.es }, { 'content-type': 'text/plain' })).status, 415);
  const res = await fetch(`${base}/api/config`, { headers: { origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
});

test('静的配信はパス走査できない', async () => {
  assert.equal((await fetch(`${base}/..%2fserver%2findex.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/nothing.js`)).status, 404);
});

async function waitStatus(id, pred) {
  let s;
  for (let i = 0; i < 100; i += 1) {
    s = await (await fetch(`${base}/api/sessions/${id}`)).json();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  return s;
}

test('旧形式の ES でセッションを作ると、設問ごと+プランが並列に走り、完了で status=ready・一覧に出る', async () => {
  calls.length = 0;
  const res = await post('/api/sessions', { es: fx.es });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.match(id, /^[A-Za-z0-9-]+$/);
  const s = await waitStatus(id, (x) => x.status !== 'reviewing');
  assert.equal(s.status, 'ready');
  assert.equal(s.esReview.items.length, 3);
  assert.deepEqual(s.esReview.items.map((i) => i.id), ['q1', 'q2', 'q3']);
  assert.equal(s.esReview.items[0].title, '学生時代に力を入れたこと');
  assert.deepEqual(s.esReview.plan, planResult);
  assert.equal(s.es.items.length, 3);
  assert.equal(s.es.company, fx.es.company);
  assert.equal(s.report, null);
  assert.deepEqual(calls.map((c) => c.kind).sort(), ['es-item', 'es-item', 'es-item', 'es-plan']);
  assert.ok(calls.find((c) => c.kind === 'es-item').prompt.includes(fx.es.gakuchika));
  assert.ok(calls.every((c) => c.plan === 'standard'));
  assert.deepEqual(Object.values(s.review.items).map((p) => p.status), ['done', 'done', 'done']);
  assert.equal(s.review.plan.status, 'done');
  assert.equal(s.expected.sec['es-item'], 25);
  const list = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(list[0].id, id);
  assert.equal(list[0].mode, 'first');
  // 実 realtime を使わずに end は 409
  assert.equal((await post(`/api/sessions/${id}/end`, {})).status, 409);
  // sdp が不正なら 400
  assert.equal((await post(`/api/sessions/${id}/realtime`, { sdp: 5 })).status, 400);
});

test('新形式の ES: 設問を増減でき、本文が空の設問は添削しない', async () => {
  calls.length = 0;
  const es = { company: 'A', industry: 'B', role: 'C', mode: 'first', plan: 'premium', items: [{ title: '設問X', limit: 100, text: '本文X' }, { title: '設問Y', limit: 0, text: '' }] };
  const { id } = await (await post('/api/sessions', { es })).json();
  const s = await waitStatus(id, (x) => x.status !== 'reviewing');
  assert.equal(s.status, 'ready');
  assert.equal(s.plan, 'premium');
  assert.equal(s.review.items.q2.status, 'skipped');
  assert.deepEqual(s.esReview.items.map((i) => i.id), ['q1']);
  assert.equal(calls.filter((c) => c.kind === 'es-item').length, 1);
  assert.ok(calls.every((c) => c.plan === 'premium'));
});

test('失敗した設問だけ retry でやり直せる。失敗していない設問は 409', async () => {
  failOnce = new Set(['自己PR']);
  const { id } = await (await post('/api/sessions', { es: fx.es })).json();
  const s = await waitStatus(id, (x) => x.status !== 'reviewing');
  assert.equal(s.status, 'ready');
  assert.equal(s.review.items.q2.status, 'error');
  assert.match(s.review.items.q2.error, /boom/);
  assert.equal(s.esReview.items.length, 2);
  assert.equal((await post(`/api/sessions/${id}/review/q1/retry`, {})).status, 409);
  assert.equal((await post(`/api/sessions/${id}/review/q9/retry`, {})).status, 404);
  assert.equal((await post(`/api/sessions/${id}/review/bad.id/retry`, {})).status, 400);
  assert.equal((await post(`/api/sessions/bad.id/review/q2/retry`, {})).status, 400);
  assert.equal((await post(`/api/sessions/${id}/review/q2/retry`, {})).status, 200);
  const after = await waitStatus(id, (x) => x.review.items.q2.status === 'done' && x.status === 'ready');
  assert.equal(after.esReview.items.length, 3);
  assert.equal(after.status, 'ready');
});

test('es の検証: items の個数・型・字数違反は 400', async () => {
  const base3 = { company: 'A', industry: 'B', role: 'C' };
  const item = { title: 't', limit: 400, text: 'x' };
  assert.equal((await post('/api/sessions', { es: { ...base3, items: [] } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { ...base3, items: Array(9).fill(item) } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { ...base3, items: [{ ...item, text: 'あ'.repeat(2001) }] } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { ...base3, mode: 'x', items: [item] } })).status, 400);
  assert.equal((await post('/api/sessions', { es: { ...base3, plan: 'gold', items: [item] } })).status, 400);
});

test('/api/config: 面接の種類（一次は必ず available）・プラン・既定の設問・見込み秒', async () => {
  const c = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(c.modes.map((m) => m.id), ['first', 'second', 'final', 'midcareer']);
  assert.equal(c.modes[0].available, true);
  assert.ok(c.modes[0].stages.length >= 5);
  assert.deepEqual(c.plans.map((p) => p.id), ['standard', 'premium']);
  assert.equal(c.defaultPlan, 'standard');
  assert.equal(c.defaultItems.midcareer.length, 4);
  assert.equal(c.maxItems, 8);
});

// ---- /api/es/extract ----
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const extractBody = (over = {}) => ({ filename: 'es.png', mime: 'image/png', dataBase64: PNG.toString('base64'), ...over });

test('extract: png / pdf を読み取って下書きを返し、LLM には一時ファイルのパスを渡す（終わったら消える）', async () => {
  calls.length = 0;
  const res = await post('/api/es/extract', extractBody());
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.company, 'テスト社');
  assert.deepEqual(d.items.map((i) => [i.title, i.limit, i.text.length]), [['自己PR', 400, 120], ['志望動機', 0, 2]]);
  const c = calls.find((x) => x.kind === 'es-extract');
  assert.equal(c.files.length, 1);
  assert.match(c.files[0], /es-source\.png$/);
  assert.ok(!existsSync(c.files[0]));
  const pdf = await post('/api/es/extract', extractBody({ filename: 'es.pdf', mime: 'application/pdf', dataBase64: PDF.toString('base64') }));
  assert.equal(pdf.status, 200);
  assert.match(calls.at(-1).files[0], /es-source\.pdf$/);
});

test('extract: 形式・サイズ・中身の違反は 400', async () => {
  const bad = [
    extractBody({ mime: 'image/gif' }),
    extractBody({ mime: 'text/html' }),
    extractBody({ filename: '' }),
    extractBody({ filename: 5 }),
    extractBody({ dataBase64: '' }),
    extractBody({ dataBase64: 5 }),
    extractBody({ dataBase64: '###notbase64###' }),
    extractBody({ dataBase64: Buffer.from('<html>').toString('base64') }), // mime と中身が違う
    extractBody({ mime: 'application/pdf' }), // png の中身を pdf と偽る
    extractBody({ dataBase64: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]).toString('base64') }), // 10MB 超
    { filename: 'a.png' },
  ];
  for (const b of bad) {
    const res = await post('/api/es/extract', b);
    assert.equal(res.status, 400, JSON.stringify(b).slice(0, 80));
  }
  assert.equal((await post('/api/es/extract', extractBody({ plan: 'gold' }))).status, 400);
  assert.equal((await post('/api/es/extract', '{broken')).status, 400);
  assert.equal((await post('/api/es/extract', extractBody(), { 'content-type': 'text/plain' })).status, 415);
});

test('extract: ちょうど 10MB は通り、本文が 20MB を超えると 413', async () => {
  const exactly = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 - PNG.length)]);
  assert.equal(exactly.length, 10 * 1024 * 1024);
  assert.equal((await post('/api/es/extract', extractBody({ dataBase64: exactly.toString('base64') }))).status, 200);
  assert.equal((await post('/api/es/extract', 'x'.repeat(20 * 1024 * 1024 + 10))).status, 413);
});

test('面接の通し（偽 realtime）: やりとりごとに面接中に採点が走り、終了で最後と全体だけが残り、レポートが出来る', async () => {
  const strong = JSON.parse(readFileSync(new URL('../fixtures/strong-transcript.json', import.meta.url), 'utf8'));
  const kinds = [];
  const llm2 = {
    ...fakeLlm,
    runStructured: async (a) => {
      kinds.push(a.kind);
      if (a.kind === 'q-score') return { score: 4, quote: /candidate: (.{15})/.exec(a.prompt)[1], good: 'g', improve: 'i', modelAnswer: 'm' };
      if (a.kind === 'final') {
        const ids = ['structure', 'specificity', 'ownership', 'consistency', 'motivation', 'responsiveness'];
        return { axes: ids.map((axis) => ({ axis, score: 4, reason: 'r', evidence: [] })), overall: { summary: 's', nextPractice: ['a', 'b', 'c'] }, compliance: { violations: [] } };
      }
      return fakeLlm.runStructured(a);
    },
  };
  let notify = null;
  const bridge2 = { startRealtime: async ({ onNotification }) => { notify = onNotification; return { threadId: 't1', answer: 'v=0 fake' }; }, stopRealtime: async () => {}, appendText: async () => {}, close: () => {} };
  const dir2 = await mkdtemp(join(tmpdir(), 'ai-interview-test2-'));
  const app2 = createApp({ bridge: bridge2, llm: llm2, dataDir: dir2 });
  await app2.init();
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${app2.server.address().port}`;
  const p2 = (path, body) => fetch(b2 + path, { method: 'POST', headers: json, body: JSON.stringify(body) });
  try {
    const { id } = await (await p2('/api/sessions', { es: strong.es })).json();
    assert.equal((await p2(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' })).status, 200);
    const role = { interviewer: 'assistant', candidate: 'user' };
    for (const t of strong.turns.slice(0, 6)) {
      notify({ method: 'thread/realtime/transcript/delta', params: { threadId: 't1', role: role[t.role], delta: t.text.slice(0, 1) } });
      notify({ method: 'thread/realtime/transcript/done', params: { threadId: 't1', role: role[t.role], text: t.text } });
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(kinds.filter((k) => k === 'q-score').length, 2); // 3 つ目の質問が出た時点で、1・2 番目のやりとりが閉じて採点済み
    const mid = await (await fetch(`${b2}/api/sessions/${id}`)).json();
    assert.deepEqual(mid.scoring.exchanges.map((e) => e.status), ['done', 'done']);
    for (const t of strong.turns.slice(6)) {
      notify({ method: 'thread/realtime/transcript/done', params: { threadId: 't1', role: role[t.role], text: t.text } });
    }
    assert.equal((await p2(`/api/sessions/${id}/end`, {})).status, 200);
    const s = await waitStatus2(b2, id, (x) => x.status === 'done');
    assert.equal(s.status, 'done');
    assert.equal(s.report.scoring.questions.length, 9);
    assert.equal(s.report.scoring.axes.length, 6);
    assert.equal(s.report.plan, 'standard');
    assert.equal(kinds.filter((k) => k === 'q-score').length, 9); // 面接中の分は採点し直さない
    assert.equal(kinds.filter((k) => k === 'final').length, 1);
    assert.equal(s.scoring.final.status, 'done');
    assert.equal((await p2(`/api/sessions/${id}/compare`, { plan: 'standard' })).status, 400); // 同じプランとの比較は不可
  } finally {
    await app2.shutdown();
    await rm(dir2, { recursive: true, force: true });
  }
});

async function waitStatus2(b, id, pred) {
  let s;
  for (let i = 0; i < 100; i += 1) {
    s = await (await fetch(`${b}/api/sessions/${id}`)).json();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  return s;
}
