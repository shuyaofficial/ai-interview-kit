import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createScorer, scoreExchange, buildQScorePrompt, buildFinalPrompt, assembleScoring } from '../server/live-scoring.mjs';
import { splitExchanges } from '../server/exchanges.mjs';
import { normalizeEs } from '../server/es.mjs';
import { AXES, FORBIDDEN_TOPICS } from '../server/rubric.mjs';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}-transcript.json`, import.meta.url), 'utf8'));
const strong = load('strong');
const es = normalizeEs(strong.es);
const exchanges = splitExchanges(strong.turns);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** プロンプトの種類で答えを返す偽ランナー。q-score は応募者の最初の発言から引用する。 */
function fakeRun({ delayMs = 0, log = [] } = {}) {
  let running = 0;
  return Object.assign(async ({ kind, prompt, schema }) => {
    log.push({ kind, prompt });
    running += 1;
    log.maxRunning = Math.max(log.maxRunning ?? 0, running);
    await sleep(delayMs);
    running -= 1;
    if (kind === 'final') {
      return {
        axes: AXES.map((a) => ({ axis: a.id, score: 4, reason: 'r', evidence: [{ turn: 1, quote: strong.turns[1].text.slice(0, 20) }] })),
        overall: { summary: 's', nextPractice: ['a', 'b', 'c'] },
        compliance: { violations: [] },
      };
    }
    assert.equal(kind, 'q-score');
    assert.ok(schema.required.includes('modelAnswer'));
    const cand = /candidate: (.{15})/.exec(prompt)[1];
    return { score: 4, quote: cand, good: 'g', improve: 'i', modelAnswer: 'm' };
  }, { log });
}

test('buildQScorePrompt: 未置換 {{ が無く、6軸の全段・採点規則・そのやりとりの発言が入る', () => {
  const p = buildQScorePrompt(es, exchanges[1]);
  assert.ok(!p.includes('{{'));
  for (const a of AXES) for (const n of [1, 2, 3, 4, 5]) assert.ok(p.includes(a.anchors[n]), `${a.id}:${n}`);
  assert.ok(p.includes(`1: candidate: ${exchanges[1].turns[1].text}`));
  assert.ok(p.includes('一字一句') && p.includes('甘く採点しない') && p.includes('新しい経験や数字を作らない') && p.includes('内部の項目名'));
  assert.ok(p.includes(es.items[0].text));
});

test('buildFinalPrompt: 未置換 {{ が無く、14事項・逐語録・質問の要約が入り、質問ごとの評価は求めない', () => {
  const jobs = [{ question: 'Q1', status: 'done', result: { score: 4, good: 'GOOD1', improve: 'IMP1' } }, { question: 'Q2', status: 'running' }];
  const p = buildFinalPrompt(es, strong.turns, jobs);
  assert.ok(!p.includes('{{'));
  for (const t of FORBIDDEN_TOPICS) assert.ok(p.includes(t.label), t.label);
  assert.ok(p.includes('GOOD1') && p.includes('まだ採点中'));
  assert.ok(p.includes(`1: candidate: ${strong.turns[1].text}`));
  assert.ok(!p.includes('modelAnswer'));
});

test('scoreExchange: 引用がそのやりとりの応募者の発言に無ければ1回だけやり直す', async () => {
  const outs = [{ score: 3, quote: '存在しない引用', good: 'g', improve: 'i', modelAnswer: 'm' }, { score: 4, quote: exchanges[1].turns[1].text.slice(0, 15), good: 'g2', improve: 'i', modelAnswer: 'm' }];
  const prompts = [];
  const r = await scoreExchange(es, exchanges[1], { run: async ({ prompt }) => { prompts.push(prompt); return outs[prompts.length - 1]; } });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('存在しない引用'));
  assert.equal(r.retried, true);
  assert.equal(r.score, 4);
  assert.equal(r.quoteInvalid, undefined);
  assert.equal(r.question, exchanges[1].question);
});

test('scoreExchange: 面接官の発言からの引用は不一致。それでも直らなければ引用を空にして quoteInvalid', async () => {
  let calls = 0;
  const r = await scoreExchange(es, exchanges[1], { run: async () => { calls += 1; return { score: 5, quote: exchanges[1].turns[0].text.slice(0, 12), good: 'g', improve: 'i', modelAnswer: 'm' }; } });
  assert.equal(calls, 2);
  assert.equal(r.quote, '');
  assert.equal(r.quoteInvalid, true);
});

test('scoreExchange: 形の崩れた結果は例外', async () => {
  await assert.rejects(scoreExchange(es, exchanges[0], { run: async () => ({ score: 9, quote: 'x', good: '', improve: '', modelAnswer: '' }) }), /形が不正/);
});

test('createScorer: やりとりごとに q-score を走らせ、同時に最大2本。同じやりとりは重複して採点しない', async () => {
  const run = fakeRun({ delayMs: 120 });
  const changes = [];
  const scorer = createScorer({ run, es, onChange: (s) => changes.push(s) });
  for (const ex of exchanges.slice(0, 5)) scorer.addExchange(ex);
  scorer.addExchange(exchanges[0]); // 重複
  assert.equal(scorer.snapshot().exchanges.length, 5);
  await sleep(30);
  assert.equal(scorer.snapshot().exchanges.filter((e) => e.status === 'running').length, 2);
  assert.equal(scorer.snapshot().exchanges.filter((e) => e.status === 'queued').length, 3);
  await sleep(600);
  assert.ok(run.log.maxRunning <= 2, `最大同時 ${run.log.maxRunning}`);
  assert.ok(scorer.snapshot().exchanges.every((e) => e.status === 'done'));
  assert.equal(run.log.filter((l) => l.kind === 'q-score').length, 5);
  assert.ok(changes.length > 5);
});

test('createScorer.finish: 面接中に済んだ分を使い回し、残りのやりとりと final だけを走らせる', async () => {
  const run = fakeRun({ delayMs: 10 });
  const scorer = createScorer({ run, es });
  for (const ex of exchanges.slice(0, 8)) scorer.addExchange(ex); // 面接中に 8 個閉じた
  await sleep(150);
  const before = run.log.length;
  assert.equal(before, 8);
  const r = await scorer.finish(strong.turns);
  const added = run.log.slice(before);
  assert.deepEqual(added.map((l) => l.kind).sort(), ['final', 'q-score']); // 終了時に走ったのはこの 2 つだけ
  assert.equal(r.scoring.questions.length, 9);
  assert.equal(r.scoring.axes.length, 6);
  assert.deepEqual(r.evidenceViolations, []);
  assert.equal(r.scoring.questions[0].question, exchanges[0].question);
  assert.deepEqual(r.scoring.overall.nextPractice, ['a', 'b', 'c']);
  assert.equal(scorer.snapshot().final.status, 'done');
});

test('createScorer.finish: 終了時に何も採点済みでなくても全部走る。final が失敗すれば例外', async () => {
  const scorer = createScorer({ run: fakeRun(), es });
  const r = await scorer.finish(strong.turns);
  assert.equal(r.scoring.questions.length, 9);
  const failing = createScorer({ es, run: async ({ kind, prompt }) => { if (kind === 'final') throw new Error('final boom'); return { score: 3, quote: /candidate: (.{15})/.exec(prompt)[1], good: 'g', improve: 'i', modelAnswer: 'm' }; } });
  await assert.rejects(failing.finish(strong.turns), /final boom/);
  assert.equal(failing.snapshot().final.status, 'error');
});

test('createScorer: q-score が2回続けて失敗したやりとりは error。レポートの質問からは外れ、他は進む', async () => {
  let bad = 0;
  const run = async ({ kind, prompt }) => {
    if (kind === 'final') return { axes: AXES.map((a) => ({ axis: a.id, score: 4, reason: 'r', evidence: [] })), overall: { summary: 's', nextPractice: ['a', 'b', 'c'] }, compliance: { violations: [] } };
    if (prompt.includes(exchanges[2].turns[1].text.slice(0, 15))) { bad += 1; throw new Error('q boom'); }
    return { score: 3, quote: /candidate: (.{15})/.exec(prompt)[1], good: 'g', improve: 'i', modelAnswer: 'm' };
  };
  const scorer = createScorer({ run, es });
  const r = await scorer.finish(strong.turns);
  assert.equal(bad, 2); // 1回だけ自動でやり直す
  assert.equal(scorer.snapshot().exchanges[2].status, 'error');
  assert.equal(r.scoring.questions.length, 8);
});

test('assembleScoring: 済んだやりとりだけを面接の順に並べる', () => {
  const fin = { axes: [], overall: { summary: '', nextPractice: [] }, llmCompliance: [], evidenceViolations: [], compliance: { violations: [] } };
  const r = assembleScoring([{ status: 'done', result: { question: 'a' } }, { status: 'error', result: null }, { status: 'done', result: { question: 'c' } }], fin);
  assert.deepEqual(r.scoring.questions.map((q) => q.question), ['a', 'c']);
});
