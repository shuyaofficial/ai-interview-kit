import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildEsReviewPrompt, buildScoringPrompt, computeSpeechMetrics, validateEvidence, scanForbidden, score,
} from '../server/scoring.mjs';
import { AXES, FORBIDDEN_TOPICS } from '../server/rubric.mjs';

const fx = JSON.parse(readFileSync(new URL('../fixtures/weak-transcript.json', import.meta.url), 'utf8'));

const turns = [
  { role: 'interviewer', text: '自己紹介をお願いします。', startMs: 0, endMs: 3000 },
  { role: 'candidate', text: 'えーと、私は山田です。あの、よろしく。', startMs: 5000, endMs: 15000 },
  { role: 'interviewer', text: 'ありがとうございます。ご家族について教えてください。', startMs: 16000, endMs: 18000 },
  { role: 'candidate', text: 'はい。まあ、頑張りました。', startMs: 26000, endMs: 36000 },
];

test('buildScoringPrompt: 未置換 {{ が無く、6軸の定義と anchors・禁止14事項・逐語録が入る', () => {
  const p = buildScoringPrompt(fx.es, fx.turns);
  assert.ok(!p.includes('{{'));
  for (const a of AXES) {
    assert.ok(p.includes(a.looksAt), a.id);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(p.includes(a.anchors[n]), `${a.id}:${n}`);
  }
  for (const t of FORBIDDEN_TOPICS) assert.ok(p.includes(t.label), t.label);
  assert.ok(p.includes(`0: interviewer: ${fx.turns[0].text}`));
  assert.ok(p.includes(`1: candidate: ${fx.turns[1].text}`));
  assert.ok(p.includes(fx.es.gakuchika));
});

test('buildEsReviewPrompt: 未置換 {{ が無い', () => {
  const p = buildEsReviewPrompt(fx.es);
  assert.ok(!p.includes('{{'));
  assert.ok(p.includes('400字'));
  assert.ok(p.includes(fx.es.motivation));
});

test('computeSpeechMetrics: 手計算と一致する', () => {
  const m = computeSpeechMetrics(turns);
  // 回答1: 19字 / 10秒 = 114字/分、フィラー えーと・あの の2回
  assert.deepEqual(m.answers[0], { turn: 1, chars: 19, sec: 10, charsPerMin: 114, fillerCount: 2 });
  // 回答2: 13字 / 10秒 = 78字/分、フィラー まあ の1回
  assert.deepEqual(m.answers[1], { turn: 3, chars: 13, sec: 10, charsPerMin: 78, fillerCount: 1 });
  assert.equal(m.totalChars, 32);
  assert.equal(m.totalSec, 20);
  assert.equal(m.charsPerMin, 96);
  assert.equal(m.fillers.total, 3);
  assert.equal(m.fillers.byWord['えーと'], 1);
  assert.equal(m.fillers.byWord['えー'], 0); // 「えーと」を「えー」と二重に数えない
  assert.equal(m.fillers.byWord['あの'], 1);
  assert.equal(m.fillers.byWord['まあ'], 1);
  assert.deepEqual(m.longestSilence, { sec: 8, afterTurn: 2 });
});

test('computeSpeechMetrics: フィラーは最長一致（あのー は あの と二重に数えない）', () => {
  const m = computeSpeechMetrics([{ role: 'candidate', text: 'あのー、えっと、あの', startMs: 0, endMs: 6000 }]);
  assert.equal(m.fillers.byWord['あのー'], 1);
  assert.equal(m.fillers.byWord['あの'], 1);
  assert.equal(m.fillers.total, 3);
});

test('validateEvidence: 一致（空白差は無視）と不一致', () => {
  const result = {
    axes: [
      { axis: 'structure', evidence: [{ turn: 1, quote: '私は 山田です' }, { turn: 1, quote: '私は鈴木です' }, { turn: 0, quote: '自己紹介' }, { turn: 9, quote: 'x' }] },
      { axis: 'specificity', evidence: [{ turn: 3, quote: 'まあ、頑張りました' }] },
    ],
    questions: [
      { questionTurn: 2, quote: '頑張りました' },
      { questionTurn: 2, quote: '作り話の引用' },
    ],
  };
  const v = validateEvidence(result, turns);
  assert.deepEqual(v.map((x) => [x.kind, x.axis ?? x.questionTurn, x.turn ?? null]), [
    ['axis', 'structure', 1],
    ['axis', 'structure', 0], // 面接官の発言は根拠にならない
    ['axis', 'structure', 9],
    ['question', 2, null],
  ]);
  assert.deepEqual(validateEvidence({ axes: [], questions: [] }, turns), []);
});

test('scanForbidden: 面接官の禁止語だけを拾う', () => {
  const found = scanForbidden([...turns, { role: 'candidate', text: '実家は東京です', startMs: 40000, endMs: 41000 }]);
  assert.deepEqual(found.map((f) => [f.turn, f.topic]), [[2, '家族']]);
  assert.deepEqual(scanForbidden(fx.turns), []);
});

function fakeResult(overrides = {}) {
  return {
    axes: AXES.map((a) => ({ axis: a.id, score: 2, reason: 'r', evidence: [{ turn: 1, quote: '私は山田です' }] })),
    questions: [{ questionTurn: 0, question: 'q', score: 2, quote: '頑張りました', good: 'g', improve: 'i', modelAnswer: 'm' }],
    overall: { summary: 's', nextPractice: ['a', 'b', 'c'] },
    compliance: { violations: [] },
    ...overrides,
  };
}

test('score: 引用が正しければ1回で終わり、compliance は scanForbidden と合算', async () => {
  let calls = 0;
  const r = await score({ ...fx.es }, turns, { run: async () => { calls += 1; return fakeResult({ compliance: { violations: [{ turn: 0, quote: '自己紹介', topic: '例' }] } }); } });
  assert.equal(calls, 1);
  assert.equal(r.retried, false);
  assert.deepEqual(r.evidenceViolations, []);
  assert.deepEqual(r.compliance.violations.map((v) => [v.turn, v.topic, v.source]), [[0, '例', 'llm'], [2, '家族', 'rule']]);
});

test('score: 引用違反は違反箇所を添えて1回だけ再採点、残った軸に evidenceInvalid', async () => {
  const prompts = [];
  const bad = fakeResult();
  bad.axes[0].evidence = [{ turn: 1, quote: '存在しない引用' }];
  bad.axes[1].evidence = [{ turn: 1, quote: '存在しない引用2' }];
  const second = fakeResult();
  second.axes[1].evidence = [{ turn: 1, quote: 'まだ存在しない' }];
  const outputs = [bad, second];
  const r = await score({ ...fx.es }, turns, { run: async ({ prompt }) => { prompts.push(prompt); return outputs[prompts.length - 1]; } });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('存在しない引用'));
  assert.ok(prompts[1].includes('structure'));
  assert.equal(r.retried, true);
  assert.equal(r.evidenceViolations.length, 1);
  assert.deepEqual(r.scoring.axes.filter((a) => a.evidenceInvalid).map((a) => a.axis), ['specificity']);
});

test('score: 軸が足りない結果は例外', async () => {
  await assert.rejects(score({ ...fx.es }, turns, { run: async () => fakeResult({ axes: [] }) }), /軸が足りない/);
});
