import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEs, normalizeReview, EsError, DEFAULT_ITEMS, itemsText } from '../server/es.mjs';

const fx = JSON.parse(readFileSync(new URL('../fixtures/weak-transcript.json', import.meta.url), 'utf8'));

test('normalizeEs: 旧形式は3設問・各400字の items に変換し、mode=first・plan=standard', () => {
  const es = normalizeEs(fx.es);
  assert.deepEqual(es.items.map((i) => [i.id, i.title, i.limit]), [
    ['q1', '学生時代に力を入れたこと', 400], ['q2', '自己PR', 400], ['q3', '志望動機', 400],
  ]);
  assert.equal(es.items[0].text, fx.es.gakuchika);
  assert.equal(es.items[2].text, fx.es.motivation);
  assert.equal(es.mode, 'first');
  assert.equal(es.plan, 'standard');
  assert.equal(es.company, fx.es.company);
  assert.equal(es.gakuchika, undefined);
});

test('normalizeEs: 入力を変更しない', () => {
  const input = structuredClone(fx.es);
  normalizeEs(input);
  assert.deepEqual(input, fx.es);
});

test('normalizeEs: 新形式は id を q1.. に振り直し、mode / plan を通す', () => {
  const es = normalizeEs({
    company: 'A', industry: 'B', role: 'C', mode: 'midcareer', plan: 'premium',
    items: [{ id: 'zzz', title: '職務要約', limit: 300, text: 'あ' }, { title: '転職理由', text: '' }],
  });
  assert.deepEqual(es.items.map((i) => [i.id, i.title, i.limit, i.text]), [['q1', '職務要約', 300, 'あ'], ['q2', '転職理由', 0, '']]);
  assert.equal(es.mode, 'midcareer');
  assert.equal(es.plan, 'premium');
});

test('normalizeEs: 不正は EsError（設問数・字数・型・mode・plan・本文なし）', () => {
  const base = { company: 'A', industry: 'B', role: 'C', items: [{ title: 't', limit: 400, text: 'x' }] };
  const bad = [
    null, [], 'x',
    { ...base, company: ' ' },
    { ...base, items: [] },
    { ...base, items: Array.from({ length: 9 }, () => ({ title: 't', text: 'x' })) },
    { ...base, items: [{ title: 't', limit: 400, text: 'あ'.repeat(2001) }] },
    { ...base, items: [{ title: 't', limit: 2001, text: 'x' }] },
    { ...base, items: [{ title: 't', limit: 1.5, text: 'x' }] },
    { ...base, items: [{ title: '', text: 'x' }] },
    { ...base, items: [{ title: 't', text: 5 }] },
    { ...base, items: [{ title: 't', text: '  ' }] },
    { ...base, mode: 'third' },
    { ...base, plan: 3 },
    { ...fx.es, gakuchika: 5 },
    { company: 'x' },
  ];
  for (const b of bad) assert.throws(() => normalizeEs(b), EsError, JSON.stringify(b)?.slice(0, 60));
  assert.equal(normalizeEs({ ...base, items: Array.from({ length: 8 }, () => ({ title: 't', text: 'x' })) }).items.length, 8);
  assert.equal(normalizeEs({ ...base, items: [{ title: 't', text: 'あ'.repeat(2000) }] }).items[0].text.length, 2000);
  assert.throws(() => normalizeEs({ ...base, plan: 'gold' }, { plans: ['standard', 'premium'] }), EsError);
});

test('既定の設問: 新卒3問×400字、中途4問（300/800/400/400）', () => {
  assert.deepEqual(DEFAULT_ITEMS.newgrad.map((i) => i.limit), [400, 400, 400]);
  assert.deepEqual(DEFAULT_ITEMS.midcareer.map((i) => [i.title, i.limit]), [['職務要約', 300], ['職務経歴と実績', 800], ['転職理由', 400], ['志望動機', 400]]);
});

test('normalizeReview: 旧形式の field を設問 id に対応づける', () => {
  const es = normalizeEs(fx.es);
  const r = normalizeReview({ items: [{ field: 'selfPr', scores: {} }], plan: { focusPoints: [] } }, es);
  assert.equal(r.items[0].id, 'q2');
  assert.equal(r.items[0].title, '自己PR');
  assert.equal(r.items[0].field, undefined);
  assert.equal(normalizeReview(null, es), null);
});

test('itemsText: 未記入の設問は「（未記入）」', () => {
  const es = normalizeEs({ company: 'A', industry: 'B', role: 'C', items: [{ title: 't1', limit: 100, text: '本文' }, { title: 't2', text: '' }] });
  const t = itemsText(es);
  assert.ok(t.includes('## t1（100字以内）\n本文') && t.includes('## t2\n（未記入）'));
});
