import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreLens, parseOverride, observeTurns, observeSessions, pickHypothesis, buildLensView, LENS_ITEMS, FACTORS, HYPOTHESES, MIN_ANSWERS } from '../server/lens.mjs';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}-transcript.json`, import.meta.url), 'utf8'));
const weak = load('weak');
const strong = load('strong');
const mid = Array(10).fill(4);

test('レンズの集計: 10問を5因子に（各2項目、逆転項目は 8−回答）', () => {
  assert.equal(LENS_ITEMS.length, 10);
  assert.deepEqual(scoreLens(mid), { extraversion: 4, agreeableness: 4, conscientiousness: 4, neuroticism: 4, openness: 4 });
  // 順項目を7、逆転項目を1 → すべて7。順項目を1、逆転項目を7 → すべて1
  const hi = LENS_ITEMS.map((it) => (it.rev ? 1 : 7));
  const lo = LENS_ITEMS.map((it) => (it.rev ? 7 : 1));
  assert.ok(Object.values(scoreLens(hi)).every((v) => v === 7));
  assert.ok(Object.values(scoreLens(lo)).every((v) => v === 1));
  // 外向性は 項目1 と 項目6（逆転）: 1問目=6, 6問目=2 → (6 + 6) / 2 = 6
  const a = [...mid]; a[0] = 6; a[5] = 2;
  assert.equal(scoreLens(a).extraversion, 6);
  assert.equal(scoreLens(a).openness, 4);
  assert.equal(FACTORS.length, 5);
  for (const bad of [null, [], Array(9).fill(4), Array(10).fill(8), Array(10).fill(0), Array(10).fill(4.5), Array(10).fill('4')]) {
    assert.throws(() => scoreLens(bad), (e) => e.status === 400);
  }
});

test('レンズの集計: 血液型・MBTI・型の名前を出さない', () => {
  const view = buildLensView({ answers: mid, override: { bars: {}, hypothesis: null } }, []);
  const text = JSON.stringify(view);
  for (const w of ['血液型', 'MBTI', 'タイプ', 'INTJ', '診断結果']) assert.ok(!text.includes(w.replace('診断結果', '診断された')), w);
  assert.ok(view.notes.some((n) => n.includes('診断ではありません')));
});

test('観察: 回答の平均字数・数字・具体例・結論の位置を決定論で数える', () => {
  const t = (text) => ({ role: 'candidate', text, startMs: 0, endMs: 1000 });
  const turns = [
    { role: 'interviewer', text: 'q', startMs: 0, endMs: 1 },
    t('私の強みは、周りを巻き込む力です。例えば、三年次に十二人のチームで月五十件の発送を担当しました。'),
    t('頑張りました。色々やりました。'),
    t('理由は二つあります。一つ目は人数、二つ目は期間です。'),
  ];
  const o = observeTurns(turns);
  assert.equal(o.answers, 3);
  assert.equal(o.numberShare, 0.33);
  assert.equal(o.exampleShare, 0.33);
  assert.equal(o.conclusionFirstShare, 0.67);
  assert.equal(o.avgChars, Math.round((turns[1].text.length + turns[2].text.length + turns[3].text.length) / 3));
  assert.equal(observeTurns([{ role: 'interviewer', text: 'q', startMs: 0, endMs: 1 }]).avgChars, null);
});

test('観察: 弱い逐語録と強い逐語録で、数字・具体例の割合が強い側で高い。複数セッションは回答数で重みづけ', () => {
  const w = observeTurns(weak.turns);
  const s = observeTurns(strong.turns);
  assert.ok(s.numberShare > w.numberShare, `${s.numberShare} > ${w.numberShare}`);
  const both = observeSessions([{ id: 'a', company: 'A', createdAt: '1', turns: weak.turns }, { id: 'b', company: 'B', createdAt: '2', turns: strong.turns }]);
  assert.equal(both.answers, w.answers + s.answers);
  assert.equal(both.sessions.length, 2);
  assert.ok(both.numberShare > w.numberShare && both.numberShare < s.numberShare);
  assert.equal(observeSessions([]).answers, 0);
  assert.equal(observeSessions([]).avgChars, null);
});

const obs = (over) => ({ answers: 6, avgChars: 250, numberShare: 0.8, exampleShare: 0.8, conclusionFirstShare: 0.8, ...over });

test('仮説: 逐語録の観察が主。質問票は観察で目立つ偏りが無いときの最初の値', () => {
  const low = { extraversion: 2, conscientiousness: 6, neuroticism: 2 };
  // 観察で結論が遅い → 質問票が外向性低めでも、観察が勝つ
  assert.equal(pickHypothesis({ values: low, obs: obs({ conclusionFirstShare: 0.2 }) }).id, 'conclusion-first');
  assert.equal(pickHypothesis({ values: null, obs: obs({ numberShare: 0.1 }) }).id, 'one-number');
  assert.equal(pickHypothesis({ values: null, obs: obs({ exampleShare: 0.2 }) }).id, 'one-example');
  assert.equal(pickHypothesis({ values: null, obs: obs({ avgChars: 600 }) }).id, 'shorter');
  assert.equal(pickHypothesis({ values: null, obs: obs({ avgChars: 80 }) }).id, 'longer');
  // 観察に偏りが無い → 質問票
  assert.equal(pickHypothesis({ values: low, obs: obs({}) }).id, 'self-pr-form');
  assert.equal(pickHypothesis({ values: { extraversion: 5, conscientiousness: 3, neuroticism: 2 }, obs: obs({}) }).id, 'prep-check');
  assert.equal(pickHypothesis({ values: { extraversion: 5, conscientiousness: 5, neuroticism: 5 }, obs: obs({}) }).id, 'reappraise');
  // 観察が少なすぎる（回答 < MIN_ANSWERS）→ 観察は使わない
  assert.equal(pickHypothesis({ values: low, obs: obs({ answers: MIN_ANSWERS - 1, conclusionFirstShare: 0 }) }).id, 'self-pr-form');
  // どちらも偏りなし
  assert.equal(pickHypothesis({ values: { extraversion: 5, conscientiousness: 5, neuroticism: 2 }, obs: obs({}) }).id, 'baseline-first');
  assert.equal(pickHypothesis({ values: null, obs: null }).id, 'baseline-first');
  // 外向性が高めでも、質問票だけでは助言を出さない
  assert.equal(pickHypothesis({ values: { extraversion: 7, conscientiousness: 5, neuroticism: 2 }, obs: null }).id, 'baseline-first');
});

test('上書き: 本人が選んだ仮説・バーが勝ち、効果が小さいことを添える', () => {
  const p = pickHypothesis({ values: null, obs: obs({ conclusionFirstShare: 0 }), chosen: 'shorter' });
  assert.equal(p.id, 'shorter');
  assert.equal(p.chosen, true);
  assert.ok(p.effectNote.includes('小さな差'));
  const view = buildLensView({ answers: mid, override: { bars: { extraversion: 2 }, hypothesis: null } }, []);
  assert.equal(view.scores.extraversion, 4);
  assert.equal(view.values.extraversion, 2);
  assert.equal(view.hypothesis.id, 'self-pr-form');
  assert.deepEqual(parseOverride({ bars: { extraversion: 3, openness: null }, hypothesis: 'one-number' }), { bars: { extraversion: 3 }, hypothesis: 'one-number' });
  for (const bad of [{ bars: { x: 3 } }, { bars: { extraversion: 9 } }, { bars: { extraversion: '3' } }, { hypothesis: 'zzz' }]) {
    assert.throws(() => parseOverride(bad), (e) => e.status === 400);
  }
  assert.ok(HYPOTHESES.every((h) => h.id && h.title && h.tryThis));
});

test('画面用の一式: 質問票も観察も無ければ仮説は出さない。観察だけでも出る', () => {
  assert.equal(buildLensView(null, []).hypothesis, null);
  assert.equal(buildLensView(null, []).values, null);
  const v = buildLensView(null, [{ id: 'a', company: 'A', createdAt: '1', turns: weak.turns }]);
  assert.equal(v.scores, null);
  assert.ok(v.hypothesis);
  assert.equal(v.observations.sessions[0].company, 'A');
});
