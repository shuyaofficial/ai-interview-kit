import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInterviewerPrompt, createRecorder, fillTemplate, loadBank, loadModeBank, listModes, MODE_DEFAULTS } from '../server/interview.mjs';
import { normalizeEs } from '../server/es.mjs';
import { FORBIDDEN_TOPICS } from '../server/rubric.mjs';

const fx = JSON.parse(readFileSync(new URL('../fixtures/weak-transcript.json', import.meta.url), 'utf8'));
fx.es = normalizeEs(fx.es);
const bank = loadBank();
const plan = { focusPoints: [{ topic: 'チームの人数', why: '規模が不明', probes: ['何人でしたか', '役割分担は'] }] };

test('buildInterviewerPrompt: 未置換の {{ が残らない', () => {
  const p = buildInterviewerPrompt(fx.es, plan, bank);
  assert.ok(!p.includes('{{'), p.match(/\{\{\w+\}\}/)?.[0]);
  assert.ok(p.includes(fx.es.company));
  assert.ok(p.includes('チームの人数'));
  assert.ok(p.includes('何人でしたか'));
});

test('buildInterviewerPrompt: 禁止14事項が全部入る', () => {
  assert.equal(FORBIDDEN_TOPICS.length, 14);
  const p = buildInterviewerPrompt(fx.es, plan, bank);
  for (const t of FORBIDDEN_TOPICS) assert.ok(p.includes(t.label), t.label);
});

test('buildInterviewerPrompt: stages は「label（目安N分）: 代表質問」、合計14分', () => {
  const p = buildInterviewerPrompt(fx.es, null, bank);
  assert.ok(p.includes(`- 自己紹介（目安2分）: ${bank.stages[0].questions[0].text}`));
  assert.ok(p.includes('- 締め（目安1分）:'));
  assert.ok(p.includes('合計 約14分'));
  assert.ok(!p.includes('{{'));
});

test('fillTemplate: ES 本文中の {{x}} は再置換されない', () => {
  assert.equal(fillTemplate('{{a}}/{{b}}', { a: '{{b}}', b: 'B' }), '{{b}}/B');
});

test('createRecorder: delta/done から turns を作る（user→candidate, assistant→interviewer）', () => {
  let clock = 1000;
  const rec = createRecorder({ now: () => clock });
  clock = 1500; // 開始から 500ms
  assert.deepEqual(rec.handle('thread/realtime/transcript/delta', { role: 'assistant', delta: 'こんにちは' }), { type: 'caption', role: 'interviewer', text: 'こんにちは', final: false });
  clock = 1800;
  rec.handle('thread/realtime/transcript/delta', { role: 'assistant', delta: '。' });
  clock = 3000;
  assert.equal(rec.handle('thread/realtime/transcript/done', { role: 'assistant', text: 'こんにちは。' }).final, true);
  clock = 4000;
  rec.handle('thread/realtime/transcript/delta', { role: 'user', delta: 'はい' });
  clock = 6000;
  rec.handle('thread/realtime/transcript/done', { role: 'user', text: 'はい、よろしくお願いします。' });
  assert.deepEqual(rec.finish(), [
    { role: 'interviewer', text: 'こんにちは。', startMs: 500, endMs: 2000 },
    { role: 'candidate', text: 'はい、よろしくお願いします。', startMs: 3000, endMs: 5000 },
  ]);
  assert.equal(rec.handle('thread/realtime/error', { role: 'user' }), null);
});

test('createRecorder: done が来なかった途中の発言も finish に含める', () => {
  let clock = 0;
  const rec = createRecorder({ now: () => clock });
  clock = 100;
  rec.handle('thread/realtime/transcript/delta', { role: 'user', delta: '途中' });
  clock = 900;
  assert.deepEqual(rec.finish(), [{ role: 'candidate', text: '途中', startMs: 100, endMs: 900 }]);
});

// ---- 面接の種類ごとの面接官プロンプト ----

// 別の作業者が作る question-banks/*.json が無くても動くよう、種類ごとに最小の質問データを用意して検査する
const stubBank = (mode) => ({
  mode, label: `${mode}面接`, purpose: `${mode}の目的`, durationMin: 20, focus: [`${mode}の重心A`, `${mode}の重心B`],
  stages: [
    { id: 'intro', label: '導入', timeboxSec: 120, questions: [{ text: `${mode}の導入の質問` }] },
    { id: 'main', label: '本題', timeboxSec: 600, questions: [{ text: `${mode}の本題の質問` }] },
  ],
});

test('buildInterviewerPrompt: 4種類すべてで未置換 {{ が無く、14事項が入り、種類ごとの目的・重心・段階が入る', () => {
  for (const mode of Object.keys(MODE_DEFAULTS)) {
    const es = { ...fx.es, mode };
    const real = loadModeBank(mode);
    for (const b of [stubBank(mode), ...(real ? [real] : [])]) {
      const p = buildInterviewerPrompt(es, plan, b);
      assert.ok(!p.includes('{{'), `${mode}: ${p.match(/\{\{\w+\}\}/)?.[0]}`);
      for (const t of FORBIDDEN_TOPICS) assert.ok(p.includes(t.label), `${mode}: ${t.label}`);
      assert.ok(p.includes(b.label), `${mode}: label`);
      assert.ok(p.includes(b.purpose), `${mode}: purpose`);
      for (const f of b.focus) assert.ok(p.includes(f), `${mode}: focus ${f}`);
      for (const s of b.stages) assert.ok(p.includes(s.label) && p.includes(s.questions[0].text), `${mode}: stage ${s.id}`);
      assert.ok(p.includes(fx.es.items[0].title) && p.includes(fx.es.items[0].text), `${mode}: ES の設問`);
    }
  }
});

test('buildInterviewerPrompt: 中途は「中途」採用、最終は確認の質問の範囲を限る一文が入る', () => {
  const mid = buildInterviewerPrompt({ ...fx.es, mode: 'midcareer' }, plan, stubBank('midcareer'));
  assert.ok(mid.includes('中途採用') && !mid.includes('新卒採用'));
  const fin = buildInterviewerPrompt({ ...fx.es, mode: 'final' }, plan, stubBank('final'));
  assert.ok(fin.includes('正当な範囲') && fin.includes('絶対に聞いてはいけないこと'));
  assert.ok(!buildInterviewerPrompt(fx.es, plan, bank).includes('正当な範囲'));
});

test('buildInterviewerPrompt: 一次は question-bank.json だけでも既定の目的・重心で組み立つ', () => {
  const p = buildInterviewerPrompt(fx.es, plan, bank);
  assert.ok(p.includes('一次面接の面接官') && p.includes(MODE_DEFAULTS.first.focus[0]));
});

test('loadModeBank / listModes: 無い種類は null / available:false、一次は必ず使える', () => {
  assert.equal(loadModeBank('nothing'), null);
  assert.equal(loadModeBank('second', '/nonexistent-dir'), null);
  assert.ok(loadModeBank('first'));
  const modes = listModes('/nonexistent-dir');
  assert.deepEqual(modes.map((m) => [m.id, m.available]), [['first', true], ['second', false], ['final', false], ['midcareer', false]]);
  assert.equal(modes[0].durationMin, 15);
  assert.ok(modes[0].stages.length >= 5);
});

test('createRecorder: onTurn は done のたびに完成した発言を渡す', () => {
  const got = [];
  let clock = 0;
  const rec = createRecorder({ now: () => clock, onTurn: (t) => got.push(t) });
  clock = 100;
  rec.handle('thread/realtime/transcript/delta', { role: 'assistant', delta: 'a' });
  clock = 500;
  rec.handle('thread/realtime/transcript/done', { role: 'assistant', text: 'おはよう' });
  assert.deepEqual(got, [{ role: 'interviewer', text: 'おはよう', startMs: 100, endMs: 500 }]);
});
