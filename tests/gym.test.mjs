import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGymPrompt, gymModeInfo, parseGymStart, parseGymAfter, parseAnxiety, nextStepHint, gymHistory, GYM_TYPES, GYM_LEVELS, ANXIETY_ITEMS, CONSULT_LINE } from '../server/gym.mjs';
import { computeRecovery, validateRebuttals, scoreGym } from '../server/gym-score.mjs';
import { scanForbidden } from '../server/scoring.mjs';
import { loadModeBank } from '../server/interview.mjs';
import { normalizeEs } from '../server/es.mjs';
import { FORBIDDEN_TOPICS, ABUSE_LABELS } from '../server/rubric.mjs';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}-transcript.json`, import.meta.url), 'utf8'));
const strong = load('strong');
const es = normalizeEs(strong.es);
const bank = loadModeBank('first');

test('ジムのプロンプト: 全タイプ×全強さで、14事項と禁止の5分類・止める合言葉が入り、未置換が無い', () => {
  assert.equal(GYM_TYPES.length * GYM_LEVELS.length, 12);
  const seen = new Set();
  for (const t of GYM_TYPES) {
    for (const l of GYM_LEVELS) {
      const p = buildGymPrompt({ es, bank, type: t.id, level: l.id });
      assert.ok(!p.includes('{{'), `${t.id}/${l.id} に未置換`);
      assert.ok(!/\{\{|\}\}/.test(p));
      for (const f of FORBIDDEN_TOPICS) assert.ok(p.includes(f.label), `${t.id}/${l.id}: ${f.label}`);
      for (const label of Object.values(ABUSE_LABELS)) assert.ok(p.includes(label), `${t.id}/${l.id}: ${label}`);
      assert.ok(p.includes('止めたい') && p.includes('ここで終わりにしましょう'));
      assert.ok(p.includes(`${t.label}・${l.label}`));
      assert.ok(p.includes(es.company) && p.includes(es.items[0].text.slice(0, 20)));
      seen.add(p);
    }
  }
  assert.equal(seen.size, 12, '12 通りすべてが別の文面');
});

test('ジムのプロンプト: タイプごとの振る舞いと強さの記述が入る', () => {
  const at = (type, level) => buildGymPrompt({ es, bank, type, level });
  assert.ok(at('logic', 'normal').includes('それは本当にあなたの判断ですか') && at('logic', 'normal').includes('3〜4段'));
  assert.ok(at('pressure', 'worst').includes('それだけですか') && at('pressure', 'worst').includes('遮る'));
  assert.ok(at('silent', 'warmup').includes('相づち') && at('silent', 'warmup').includes('短い質問'));
  assert.ok(at('timed', 'warmup').includes('30秒'));
  assert.ok(at('logic', 'warmup').includes('遮らない') && at('logic', 'worst').includes('10秒'));
  assert.throws(() => buildGymPrompt({ es, bank, type: 'x', level: 'normal' }), /不正/);
  assert.throws(() => buildGymPrompt({ es, bank, type: 'logic', level: 'x' }), /不正/);
});

test('gymModeInfo: 採点側の面接の種類にジムの設定と「回答の内容だけを見る」が入る', () => {
  const info = gymModeInfo(bank, 'pressure', 'worst');
  assert.ok(info.label.includes('圧迫型・本番最悪想定') && info.label.includes('回答の内容だけ'));
  assert.equal(info.stages, bank.stages);
});

test('開始の検証: 同意が毎回必要。type・level・6項目の自己評価が不正なら 400', () => {
  const ok = { consent: true, type: 'logic', level: 'warmup', anxiety: [1, 2, 3, 4, 5, 1], reappraisal: ' 体が準備している ' };
  const parsed = parseGymStart(ok);
  assert.deepEqual(parsed, { type: 'logic', level: 'warmup', anxietyBefore: [1, 2, 3, 4, 5, 1], reappraisal: '体が準備している' });
  for (const bad of [{ ...ok, consent: false }, { ...ok, consent: 'true' }, { ...ok, consent: undefined }, { ...ok, type: 'x' }, { ...ok, level: 'hard' },
    { ...ok, anxiety: [1, 2, 3] }, { ...ok, anxiety: [1, 2, 3, 4, 5, 6] }, { ...ok, anxiety: [1, 2, 3, 4, 5, 1.5] }, { ...ok, reappraisal: 'あ'.repeat(201) }]) {
    assert.throws(() => parseGymStart(bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(ANXIETY_ITEMS.length, 6);
  assert.throws(() => parseAnxiety(null), (e) => e.status === 400);
  assert.deepEqual(parseGymAfter({ anxiety: [1, 1, 1, 1, 1, 1], stopReason: 'tired', selfTalk: true }), { anxietyAfter: [1, 1, 1, 1, 1, 1], stopReason: 'tired', selfTalk: true });
  assert.throws(() => parseGymAfter({ anxiety: [1, 1, 1, 1, 1, 1], stopReason: 'x' }), (e) => e.status === 400);
});

test('次の段階: 強い不安・途中で止めた人には自動で勧めない。落ち着いていれば次を提示', () => {
  const calm = [1, 2, 1, 2, 1, 2];
  const strongAnx = [5, 4, 5, 4, 4, 5];
  assert.equal(nextStepHint({ level: 'warmup', stopped: false, anxietyAfter: strongAnx }).suggest, null);
  assert.equal(nextStepHint({ level: 'warmup', stopped: true, anxietyAfter: calm }).suggest, null);
  assert.equal(nextStepHint({ level: 'warmup', stopped: false, anxietyAfter: null }).suggest, null);
  assert.equal(nextStepHint({ level: 'warmup', stopped: false, anxietyAfter: calm }).suggest, 'normal');
  assert.equal(nextStepHint({ level: 'worst', stopped: false, anxietyAfter: calm }).suggest, null);
  assert.ok(CONSULT_LINE.includes('労働局') && CONSULT_LINE.includes('就活ハラスメント悩み相談室') && CONSULT_LINE.includes('練習のための設定'));
});

test('広げた scanForbidden: 侮辱・外見・出身・性的な内容・脅しの語を拾い、既存の14事項の語と分類で区別する', () => {
  const say = (text) => scanForbidden([{ role: 'interviewer', text, startMs: 0, endMs: 1 }]).map((f) => [f.topic, f.category]);
  assert.deepEqual(say('その理由では、他の方法でも同じ結果になりませんか'), []); // 厳しい指摘でも、回答の内容に向いた文は拾わない
  assert.deepEqual(say('あなたは本当にバカですね'), [['バカ', 'insult']]);
  assert.deepEqual(say('見た目が頼りないですね'), [['見た目', 'appearance']]);
  assert.deepEqual(say('田舎の出身だから視野が狭いのでは'), [['田舎', 'origin']]);
  assert.deepEqual(say('彼氏はいますか'), [['彼氏', 'sexual']]);
  assert.deepEqual(say('結婚の予定は'), [['結婚', 'sexual']]);
  assert.deepEqual(say('落とすぞ'), [['落とすぞ', 'threat']]);
  assert.deepEqual(say('ご家族は何をされていますか'), [['家族', undefined]]);
  assert.deepEqual(say('お前には無理だ'), [['お前', 'insult']]);
  assert.equal(scanForbidden([{ role: 'candidate', text: 'バカにされた経験があります', startMs: 0, endMs: 1 }]).length, 0, '応募者の発言は見ない');
  assert.deepEqual(scanForbidden(strong.turns), []);
  assert.deepEqual(scanForbidden(load('weak').turns), []);
});

test('立て直しの速さ: 面接官の発言の直後の回答ごとに、答え始めるまでの秒と言いよどみ数を決定論で出す', () => {
  const turns = [
    { role: 'interviewer', text: '自己紹介をお願いします。', startMs: 0, endMs: 3000 },
    { role: 'candidate', text: 'えーと、山田です。あの、よろしくお願いします。', startMs: 4200, endMs: 9000 },
    { role: 'interviewer', text: 'それだけですか。', startMs: 9500, endMs: 11000 },
    { role: 'candidate', text: 'はい。', startMs: 18000, endMs: 18500 },
    { role: 'candidate', text: 'まあ、なんか、えっと、続きです。', startMs: 18600, endMs: 20000 },
    { role: 'interviewer', text: '根拠は。', startMs: 21000, endMs: 22000 },
    { role: 'candidate', text: '数字です。', startMs: 21500, endMs: 23000 },
  ];
  const r = computeRecovery(turns);
  assert.deepEqual(r.answers.map((a) => [a.turn, a.startSec, a.fillers, a.overlap]), [[1, 1.2, 2, false], [3, 7, 0, false], [6, 0, 0, true]]);
  assert.equal(r.count, 3);
  assert.equal(r.avgStartSec, 2.7);
  assert.equal(r.maxStartSec, 7);
  assert.equal(r.slowCount, 1);
  assert.equal(r.totalFillers, 2);
  assert.equal(r.fillersPerAnswer, 0.7);
  const empty = computeRecovery([{ role: 'interviewer', text: 'q', startMs: 0, endMs: 1 }]);
  assert.equal(empty.count, 0);
  assert.equal(empty.avgStartSec, null);
  assert.deepEqual(computeRecovery(strong.turns), computeRecovery(strong.turns));
});

const rebTurns = [
  { role: 'interviewer', text: 'ES の成果は、本当にあなたの判断ですか。', startMs: 0, endMs: 3000 },
  { role: 'candidate', text: '正確には先輩の指示も入っていました。私が決めたのは手順書の改訂です。その後、毎週の振り返りに変えました。', startMs: 3500, endMs: 15000 },
  { role: 'interviewer', text: '他の人でもできますよね。', startMs: 15500, endMs: 17000 },
];

test('切り返しの型: 引用が回答に無い「満たした」は満たしていないことにする。面接官の発言以外の turn・回答が無い質問は捨てる', () => {
  const part = (met, quote) => ({ met, quote });
  const result = {
    rebuttals: [
      { turn: 0, question: 'q', fact: part(true, '先輩の指示も入っていました'), responsibility: part(true, '私が決めたのは手順書の改訂です'), update: part(true, '存在しない引用です存在しない'), comment: 'c' },
      { turn: 1, question: '候補者の発言', fact: part(true, '正確には'), responsibility: part(false, ''), update: part(false, ''), comment: '' },
      { turn: 2, question: '回答なし', fact: part(true, 'x'), responsibility: part(false, ''), update: part(false, ''), comment: '' },
    ],
    summary: 's',
  };
  const v = validateRebuttals(result, rebTurns);
  assert.equal(v.rebuttals.length, 1);
  const [r] = v.rebuttals;
  assert.deepEqual([r.fact.met, r.responsibility.met, r.update.met], [true, true, false]);
  assert.equal(r.update.quoteInvalid, true);
  assert.equal(r.complete, false);
  assert.deepEqual([v.asked, v.complete, v.counts], [1, 0, { fact: 1, responsibility: 1, update: 0 }]);
});

test('切り返しの型: 3点そろえば complete。LLM の失敗でも立て直しの速さは返す', async () => {
  const good = { rebuttals: [{ turn: 0, question: 'q', fact: { met: true, quote: '先輩の指示も入っていました' }, responsibility: { met: true, quote: '私が決めたのは手順書の改訂です' }, update: { met: true, quote: '毎週の振り返りに変えました' }, comment: 'c' }], summary: 's' };
  const prompts = [];
  const ok = await scoreGym({ es, turns: rebTurns, type: 'pressure', level: 'normal', run: async ({ prompt, schema }) => { prompts.push(prompt); assert.ok(schema.required.includes('rebuttals')); return good; } });
  assert.equal(ok.rebound.complete, 1);
  assert.equal(ok.error, null);
  assert.ok(!prompts[0].includes('{{') && prompts[0].includes('圧迫型・ふつう') && prompts[0].includes('偽りや盛った答えを良しとしない'));
  const ng = await scoreGym({ es, turns: rebTurns, type: 'pressure', level: 'normal', run: async () => { throw new Error('boom'); } });
  assert.equal(ng.rebound, null);
  assert.match(ng.error, /boom/);
  assert.equal(ng.recovery.count, 1);
});

test('ジムの履歴: 三人称ひとことを使った回・使わなかった回の平均点を並べ、開始しただけの回は含めない', () => {
  const g = (id, selfTalk, scores, extra = {}) => ({ id, createdAt: `2026-10-0${id}`, company: 'A', status: 'done', scores, gym: { type: 'logic', level: 'warmup', selfTalk, anxietyBefore: [3, 3, 3, 3, 3, 3], anxietyAfter: [2, 2, 2, 2, 2, 2] }, ...extra });
  const all = { structure: 5, specificity: 5, ownership: 5, consistency: 5, motivation: 5, responsiveness: 5 };
  const mid = { structure: 3, specificity: 3, ownership: 3, consistency: 3, motivation: 3, responsiveness: 3 };
  const pts = (s) => Math.round((Object.values(s).reduce((a, b) => a + b, 0) / 6 / 5) * 100);
  const h = gymHistory([g('1', true, all), g('2', true, mid), g('3', false, mid), g('4', null, mid), { id: '5', createdAt: 'x', status: 'ready', gym: { type: 'logic', level: 'warmup' } }, { id: '6', createdAt: 'y', status: 'done', scores: mid }], pts);
  assert.equal(h.items.length, 4);
  assert.deepEqual(h.selfTalk, { used: { n: 2, avgPoints: 80 }, notUsed: { n: 1, avgPoints: 60 } });
  assert.equal(h.items[0].id, '4');
  assert.equal(h.items[0].anxietyBefore, 3);
});
