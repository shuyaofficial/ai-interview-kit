import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFeedback } from '../server/feedback.mjs';
import { startHarness } from './helpers/app-harness.mjs';

const full = { rating: 3, sendToDev: true, good: { picks: ['interview'], text: '声が自然' }, bad: { picks: ['es', 'report'], text: '入力欄が多い' } };

test('parseFeedback: 使いやすさは1〜5の整数、選択肢は決まったもの、自由記入は2000字まで', () => {
  assert.deepEqual(parseFeedback(full), full);
  for (const rating of [0, 6, 2.5, '3', null, undefined]) assert.throws(() => parseFeedback({ ...full, rating }), /rating/);
  assert.throws(() => parseFeedback({ ...full, bad: { picks: ['nope'], text: '' } }), /picks/);
  assert.throws(() => parseFeedback({ ...full, good: { picks: 'es', text: '' } }), /picks/);
  assert.throws(() => parseFeedback({ ...full, bad: { picks: [], text: 5 } }), /文字列/);
  assert.equal(parseFeedback({ ...full, bad: { picks: [], text: 'あ'.repeat(2000) } }).bad.text.length, 2000);
  assert.throws(() => parseFeedback({ ...full, bad: { picks: [], text: 'あ'.repeat(2001) } }), /2000 字以内/);
  assert.throws(() => parseFeedback({ ...full, good: { picks: [], text: 'あ'.repeat(2001) } }), /2000 字以内/);
  assert.equal(parseFeedback({ ...full, bad: { picks: [], text: '😀'.repeat(2000) } }).bad.text.length, 4000); // サロゲートペアは1字と数える
});

test('parseFeedback: 送るにチェックが無ければ、使いにくかった点だけを空にして返す', () => {
  const out = parseFeedback({ ...full, sendToDev: false });
  assert.deepEqual(out, { rating: 3, sendToDev: false, good: full.good, bad: { picks: [], text: '' } });
  assert.equal(parseFeedback({ rating: 5 }).sendToDev, false);
});

test('API: 2001字は 400 で保存されない。保存は data/feedback/<日時>-<乱数>.json で、逐語録・ES・点数・端末IDを含まない', async () => {
  const h = await startHarness();
  try {
    const { cookie } = await h.newDevice();
    const c = h.client(cookie);
    const over = await c.post('/api/feedback', { ...full, bad: { picks: [], text: 'あ'.repeat(2001) } });
    assert.equal(over.status, 400);
    assert.equal((await (await c.get('/api/quota')).json()).surveyDone, false);
    assert.deepEqual(await readdir(join(h.dir, 'feedback')).catch(() => []), []);
    assert.equal((await c.post('/api/feedback', { ...full, rating: 9 })).status, 400);
    const ok = await c.post('/api/feedback', full);
    assert.equal(ok.status, 200);
    const files = await readdir(join(h.dir, 'feedback'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}-\d{6}-[a-f0-9]{6}\.json$/);
    const raw = await readFile(join(h.dir, 'feedback', files[0]), 'utf8');
    const saved = JSON.parse(raw);
    assert.deepEqual(Object.keys(saved).sort(), ['bad', 'createdAt', 'good', 'id', 'rating', 'sendToDev']);
    assert.ok(!raw.includes(cookie.split('=')[1]), '端末IDを含まない');
    assert.equal(saved.bad.text, '入力欄が多い');
    assert.equal((await (await c.get('/api/quota')).json()).surveyDone, true);
    assert.equal((await c.post('/api/feedback', full)).status, 409); // 回答済み
  } finally { await h.cleanup(); }
});

test('API: 送るのチェックを外すと、使いにくかった点だけが空になる', async () => {
  const h = await startHarness();
  try {
    const c = h.client((await h.newDevice()).cookie);
    assert.equal((await c.post('/api/feedback', { ...full, sendToDev: false })).status, 200);
    const [f] = await readdir(join(h.dir, 'feedback'));
    const saved = JSON.parse(await readFile(join(h.dir, 'feedback', f), 'utf8'));
    assert.equal(saved.rating, 3);
    assert.equal(saved.sendToDev, false);
    assert.deepEqual([saved.good, saved.bad], [full.good, { picks: [], text: '' }]);
  } finally { await h.cleanup(); }
});

test('/api/config: アンケートの選択肢と字数の上限、ESなし用の評価軸が載る', async () => {
  const h = await startHarness();
  try {
    const cfg = await (await h.client().get('/api/config')).json();
    assert.equal(cfg.feedback.maxChars, 2000);
    assert.ok(cfg.feedback.areas.length >= 8);
    const consistency = cfg.axesNoEs.find((a) => a.id === 'consistency');
    assert.ok(!consistency.looksAt.includes('ES') && Object.values(consistency.anchors).every((t) => !t.includes('ES')));
    assert.ok(cfg.axes.find((a) => a.id === 'consistency').looksAt.includes('ES'));
  } finally { await h.cleanup(); }
});
