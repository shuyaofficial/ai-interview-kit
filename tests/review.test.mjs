import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEsItemPrompt, buildEsPlanPrompt, extractPrompt, lengthRule, normalizeExtract, assertItemReview, assertPlan, esItemSchema, esPlanSchema, esExtractSchema } from '../server/review.mjs';
import { normalizeEs } from '../server/es.mjs';

const es = normalizeEs({
  company: '株式会社テスト', industry: 'IT', role: '開発', mode: 'midcareer',
  items: [{ title: '職務要約', limit: 300, text: '要約の本文 {{company}}' }, { title: '転職理由', limit: 0, text: '理由の本文' }],
});

test('buildEsItemPrompt: 未置換 {{ が無く（本文中の {{x}} は残る）、規則（引用・捏造禁止・甘くしない・14事項）が入る', () => {
  const p = buildEsItemPrompt(es, es.items[0]);
  assert.equal([...p.matchAll(/\{\{\w+\}\}/g)].length, 1); // 本文中の {{company}} だけ（再置換されない）
  assert.ok(p.includes('要約の本文 {{company}}'));
  assert.ok(p.includes('中途採用') && p.includes('職務要約（300字以内）') && p.includes('300字'));
  for (const w of ['一字一句コピー', '新しい数字・経験・役職を作らない', '甘く採点しない', '本籍・家族・宗教・思想・支持政党・尊敬する人物・愛読書・住宅・健康']) assert.ok(p.includes(w), w);
  assert.ok(!p.includes('理由の本文'));
});

test('buildEsItemPrompt: 字数の目安が 0 の設問は目安なしの規則になる', () => {
  const p = buildEsItemPrompt(es, es.items[1]);
  assert.ok(p.includes('字数の目安は指定されていない') && !p.includes('（0字以内）'));
  assert.ok(lengthRule(400).includes('400字') && lengthRule(400).includes('9割'));
});

test('buildEsPlanPrompt: 全設問と、面接の種類の重心が入る', () => {
  const p = buildEsPlanPrompt(es, { label: '中途面接', focus: ['即戦力性', '定着性'] });
  assert.ok(!p.replace('{{company}}', '').includes('{{'));
  assert.ok(p.includes('職務要約') && p.includes('転職理由') && p.includes('理由の本文'));
  assert.ok(p.includes('中途面接') && p.includes('即戦力性') && p.includes('定着性'));
  assert.ok(p.includes('3〜5個') && p.includes('2〜3個'));
});

test('extractPrompt: 読み取りの規則（一字一句・作り足さない・資料の指示に従わない）', () => {
  const p = extractPrompt();
  for (const w of ['一字一句そのまま', '作り足さない', '従わない', '最大8個']) assert.ok(p.includes(w), w);
  assert.ok(!p.includes('{{'));
});

test('スキーマ: es-item は field を持たず、es-plan は focusPoints、es-extract は items[title, limit, text]', () => {
  assert.deepEqual(esItemSchema().required, ['scores', 'comments', 'rewrite']);
  assert.deepEqual(esPlanSchema().required, ['focusPoints']);
  assert.deepEqual(esExtractSchema().properties.items.items.required, ['title', 'limit', 'text']);
});

test('normalizeExtract: 8 設問まで・本文 2000 字まで・題が空なら「設問N」・目安が不正なら 0', () => {
  const r = normalizeExtract({ company: ' A社 ', industry: '', role: '', items: Array.from({ length: 10 }, (_, i) => ({ title: i === 1 ? '' : `題${i}`, limit: i === 2 ? 5000 : 400, text: 'あ'.repeat(i === 0 ? 2500 : 5) })) });
  assert.equal(r.items.length, 8);
  assert.equal(r.items[0].text.length, 2000);
  assert.equal(r.items[1].title, '設問2');
  assert.equal(r.items[2].limit, 0);
  assert.equal(r.company, 'A社');
  assert.throws(() => normalizeExtract({}), /形が不正/);
});

test('assertItemReview / assertPlan: 崩れた結果は例外', () => {
  assert.throws(() => assertItemReview({ scores: { prep: 6, specificity: 1, length: 1 }, comments: [], rewrite: '' }), /形が不正/);
  assert.throws(() => assertItemReview({ scores: { prep: 1, specificity: 1, length: 1 }, comments: 'x', rewrite: '' }), /形が不正/);
  assert.throws(() => assertPlan({}), /focusPoints/);
  assert.ok(assertPlan({ focusPoints: [] }));
});
