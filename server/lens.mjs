// lens（話し方の傾向）: 10問の自己記入（TIPI-J 相当）を5つの連続バーにし、逐語録の観察値と合わせて「最初に試す仮説」を1つ出す。
// 型や診断は出さない。主な材料は逐語録（回答の長さ・数字・具体例・結論の位置）。質問票は最初の値を決めるだけ。
// 質問文: 小塩真司・阿部晋吾・カトローニ ピノ (2012)「日本語版 Ten Item Personality Inventory (TIPI-J) 作成の試み」パーソナリティ研究 21(1)。
import { HttpError } from './http-util.mjs';
import { computeSpeechMetrics } from './scoring.mjs';

/** 7段階（1: まったく違うと思う 〜 7: 強くそう思う）。rev は逆転項目。 */
export const LENS_ITEMS = [
  { text: '活発で、外向的だと思う', factor: 'extraversion', rev: false },
  { text: '他の人に不満を持ち、ケンカをしがちだと思う', factor: 'agreeableness', rev: true },
  { text: 'しっかりしていて、自分に厳しいと思う', factor: 'conscientiousness', rev: false },
  { text: '心配性で、うろたえやすいと思う', factor: 'neuroticism', rev: false },
  { text: '新しいことが好きで、変わった考えをもつと思う', factor: 'openness', rev: false },
  { text: 'ひかえめで、おとなしいと思う', factor: 'extraversion', rev: true },
  { text: '人に気をつかう、やさしい人間だと思う', factor: 'agreeableness', rev: false },
  { text: 'だらしなく、うっかりしていると思う', factor: 'conscientiousness', rev: true },
  { text: 'ものごとに動じない、冷静な人間だと思う', factor: 'neuroticism', rev: true },
  { text: '新しいことが嫌いで、発想が貧困だと思う', factor: 'openness', rev: true },
];
export const LENS_SCALE = ['まったく違うと思う', '違うと思う', 'どちらかといえば違うと思う', 'どちらでもない', 'どちらかといえばそう思う', 'そう思う', '強くそう思う'];

export const FACTORS = [
  { id: 'extraversion', label: '外向性', low: 'ひかえめ', high: '活発', hint: '人前で自分から話す勢い' },
  { id: 'agreeableness', label: '協調性', low: '率直', high: 'やわらかい', hint: '相手に合わせる、気をつかう傾向' },
  { id: 'conscientiousness', label: '誠実性', low: '柔軟', high: '計画的', hint: '準備や自己管理をきっちりする傾向' },
  { id: 'neuroticism', label: '心配の出やすさ', low: '落ち着いている', high: '心配が出やすい', hint: '緊張や不安を感じやすい傾向（能力の高低とは別）' },
  { id: 'openness', label: '開放性', low: '慣れたやり方', high: '新しいこと好き', hint: '新しい考えや経験への関心' },
];
const FACTOR_IDS = FACTORS.map((f) => f.id);

const round2 = (n) => Math.round(n * 100) / 100;

/** 10個の回答（各 1〜7）から、5因子の値（1〜7、各因子は2項目の平均）を出す。不正なら 400。 */
export function scoreLens(answers) {
  const ok = Array.isArray(answers) && answers.length === LENS_ITEMS.length && answers.every((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (!ok) throw new HttpError(400, 'answers は 1〜7 の整数 10 個');
  const sums = Object.fromEntries(FACTOR_IDS.map((f) => [f, 0]));
  LENS_ITEMS.forEach((it, i) => { sums[it.factor] += it.rev ? 8 - answers[i] : answers[i]; });
  return Object.fromEntries(FACTOR_IDS.map((f) => [f, round2(sums[f] / 2)]));
}

/** 本人の上書きを検証する。bars: 因子ごとの 1〜7（null で上書きを外す）、hypothesis: 仮説の id か null。 */
export function parseOverride(body) {
  const bars = {};
  for (const [k, v] of Object.entries(body?.bars ?? {})) {
    if (!FACTOR_IDS.includes(k)) throw new HttpError(400, `bars の因子が不正: ${k}`);
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 7) throw new HttpError(400, 'bars の値は 1〜7');
    bars[k] = round2(v);
  }
  const hypothesis = body?.hypothesis ?? null;
  if (hypothesis !== null && !HYPOTHESES.some((h) => h.id === hypothesis)) throw new HttpError(400, 'hypothesis が不正');
  return { bars, hypothesis };
}

// ---- 逐語録の観察（文字列による目安。意味を理解した判定ではない）----

const NUMBER_RE = /[0-9０-９]|[一二三四五六七八九十百千万]+(?:人|名|件|回|割|倍|円|時間|日|週間|か月|ヶ月|カ月|年|冊|点|％|パーセント)/;
const EXAMPLE_RE = /(例えば|たとえば|具体的には|ある(?:時|とき|日)|その(?:時|とき)|当時|場面|エピソード|のとき|した際)/;
const CONCLUSION_RE = /(結論|一言で|端的に|(?:強み|長所|短所|理由|動機|目標|学び|取り組み|やりたいこと)は|(?:と|を|が)(?:考え|思い)(?:て)?(?:い)?ます|したいと(?:考え|思)|を(?:挙げ|選び)ます)/;

const firstSentence = (text) => {
  const m = /^[^。！？!?]+[。！？!?]?/.exec(text.trim());
  return (m ? m[0] : text).slice(0, 80);
};

/**
 * 応募者の回答ごとの観察。turns は逐語録。
 * @returns {{answers: number, avgChars: number|null, numberShare: number|null, exampleShare: number|null, conclusionFirstShare: number|null}}
 */
export function observeTurns(turns) {
  const texts = turns.filter((t) => t.role === 'candidate').map((t) => t.text);
  const n = texts.length;
  if (!n) return { answers: 0, avgChars: null, numberShare: null, exampleShare: null, conclusionFirstShare: null };
  const share = (pred) => round2(texts.filter(pred).length / n);
  return {
    answers: n,
    avgChars: Math.round(computeSpeechMetrics(turns).totalChars / n),
    numberShare: share((t) => NUMBER_RE.test(t)),
    exampleShare: share((t) => EXAMPLE_RE.test(t)),
    conclusionFirstShare: share((t) => CONCLUSION_RE.test(firstSentence(t))),
  };
}

/** 直近の複数の逐語録をまとめた観察（回答数で重みづけ）。sessions は [{id, company, createdAt, turns}]。 */
export function observeSessions(sessions) {
  const per = sessions.map((s) => ({ id: s.id, company: s.company, createdAt: s.createdAt, ...observeTurns(s.turns) })).filter((o) => o.answers > 0);
  const total = per.reduce((a, o) => a + o.answers, 0);
  const mean = (key) => (total ? round2(per.reduce((a, o) => a + o[key] * o.answers, 0) / total) : null);
  return {
    sessions: per,
    answers: total,
    avgChars: total ? Math.round(per.reduce((a, o) => a + o.avgChars * o.answers, 0) / total) : null,
    numberShare: mean('numberShare'),
    exampleShare: mean('exampleShare'),
    conclusionFirstShare: mean('conclusionFirstShare'),
  };
}

// ---- 最初に試す仮説 ----

export const MIN_ANSWERS = 3;
export const HYPOTHESES = [
  { id: 'conclusion-first', title: '各回答の最初の1文で、結論を言う', tryThis: '「私の強みは〇〇です」「理由は2つあります」の形で話し始める。', basis: 'transcript' },
  { id: 'one-number', title: '回答に数字を1つ入れる', tryThis: '人数・期間・回数・割合のどれか1つを、回答の中で言う。', basis: 'transcript' },
  { id: 'one-example', title: '具体的な場面を1つ話す', tryThis: '「例えば、〇月に…」の形で、1つの場面を短く話す。', basis: 'transcript' },
  { id: 'shorter', title: '1回答を短くまとめる', tryThis: '結論と根拠を1つずつにして、1分（約300字）に収める。', basis: 'transcript' },
  { id: 'longer', title: '1回答に理由と場面を足す', tryThis: '一言で終わらせず、理由と具体的な場面を1つずつ足す。', basis: 'transcript' },
  { id: 'self-pr-form', title: '自己宣伝の型を先に決める', tryThis: '具体例を1つ、数字を1つ入れた自己PRを、先に作って声に出す。', basis: 'questionnaire' },
  { id: 'prep-check', title: '準備のチェックを先に済ませる', tryThis: 'ES・企業の事業・答えの骨子を、練習の前に紙に書き出す。', basis: 'questionnaire' },
  { id: 'reappraise', title: '緊張の読み替えを先に試す', tryThis: '「心拍が上がるのは、体が備えている状態」と言い換えてから話し始める。', basis: 'questionnaire' },
  { id: 'baseline-first', title: 'まず1本、通しで話して決める', tryThis: '質問票からは優先する点が出ません。1本通して話し、逐語録の観察から決める。', basis: 'none' },
];
const hyp = (id) => HYPOTHESES.find((h) => h.id === id);

const EFFECT_NOTE = '研究で見つかっているのは小さな差で、あなたに当てはまるとは限りません。仮説として1回試し、合わなければ変えてください。';

/** 観察が足りていて、目立つ偏りがあれば、その仮説。優先順は結論の位置 → 数字 → 具体例 → 長さ。 */
function fromObservations(obs) {
  if (!obs || obs.answers < MIN_ANSWERS) return null;
  if (obs.conclusionFirstShare < 0.5) return { id: 'conclusion-first', evidence: `最初の1文に結論の合図がある回答は ${Math.round(obs.conclusionFirstShare * 100)}%` };
  if (obs.numberShare < 0.4) return { id: 'one-number', evidence: `数字が入った回答は ${Math.round(obs.numberShare * 100)}%` };
  if (obs.exampleShare < 0.5) return { id: 'one-example', evidence: `場面の合図がある回答は ${Math.round(obs.exampleShare * 100)}%` };
  if (obs.avgChars > 450) return { id: 'shorter', evidence: `回答の平均が ${obs.avgChars} 字（1分の目安は約300字）` };
  if (obs.avgChars < 120) return { id: 'longer', evidence: `回答の平均が ${obs.avgChars} 字` };
  return null;
}

/** 質問票の値（上書き後）から、最初の値としての仮説。 */
function fromQuestionnaire(values) {
  if (!values) return null;
  if (values.extraversion <= 3.5) return { id: 'self-pr-form', evidence: '外向性のバーが低め' };
  if (values.conscientiousness <= 3.5) return { id: 'prep-check', evidence: '誠実性のバーが低め' };
  if (values.neuroticism >= 4.5) return { id: 'reappraise', evidence: '心配の出やすさのバーが高め' };
  return null;
}

/** 本人が選んだ仮説があればそれ。なければ、逐語録の観察 → 質問票 → 通しで話してから、の順。 */
export function pickHypothesis({ values, obs, chosen }) {
  const pick = chosen ? { id: chosen, evidence: '自分で選んだ' } : fromObservations(obs) ?? fromQuestionnaire(values) ?? { id: 'baseline-first', evidence: '観察と質問票のどちらからも目立つ偏りが出ていない' };
  const base = hyp(pick.id);
  return { ...base, evidence: pick.evidence, chosen: Boolean(chosen), effectNote: EFFECT_NOTE };
}

export const LENS_NOTES = [
  '性格の型や診断ではありません。10問の自己記入を、5つの連続したバーにしただけです。',
  '主な材料は、あなたの面接の逐語録（回答の長さ、数字、具体例、結論の位置）です。質問票は最初の値を決めるだけです。',
  'バーも仮説も、いつでも自分で書き換えられます。データはこの端末の中だけにあります。',
];

/** 画面用の一式。store は { answers, override } か null。 */
export function buildLensView(store, sessions) {
  const scores = store?.answers ? scoreLens(store.answers) : null;
  const override = store?.override ?? { bars: {}, hypothesis: null };
  const values = scores ? Object.fromEntries(FACTOR_IDS.map((f) => [f, override.bars?.[f] ?? scores[f]])) : null;
  const obs = observeSessions(sessions);
  return {
    items: LENS_ITEMS.map((it) => ({ text: it.text })),
    scale: LENS_SCALE,
    factors: FACTORS,
    answers: store?.answers ?? null,
    scores,
    override: { bars: override.bars ?? {}, hypothesis: override.hypothesis ?? null },
    values,
    observations: obs,
    hypothesis: scores || obs.answers ? pickHypothesis({ values, obs, chosen: override.hypothesis }) : null,
    hypotheses: HYPOTHESES.map((h) => ({ id: h.id, title: h.title })),
    notes: LENS_NOTES,
    minAnswers: MIN_ANSWERS,
    source: 'TIPI-J（小塩・阿部・カトローニ 2012）',
  };
}
