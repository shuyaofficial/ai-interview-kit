// warmup: 本番までの日数に合わせて組み替える練習の計画、実施記録、自信度の自己申告、1日目と最終回の点の差。
// 7つの練習の並びは、研究の直接の裏付けが無い設計上の仮説（間隔・想起・目標を絞る、の原理を組み合わせたもの）。
import { HttpError } from './http-util.mjs';
import { rankFromScores } from '../web/rank.mjs';
import { LABELS } from '../web/js/labels.mjs';

export const STEPS = [
  { id: 'baseline', title: '基準を測る', todo: '通しで面接を1本やる。結果の「改善点」から、直す点を1つだけ選ぶ。', action: 'interview' },
  { id: 'narrow', title: '1点に絞る', todo: '1つ目と同じ質問に、メモを見ずに答える。直す点は1つだけに絞る。', action: 'interview' },
  { id: 'recall', title: '寝かせる', todo: '5分。質問カードだけを見て、答えを思い出して声に出す。新しいことは足さない。', action: 'recall' },
  { id: 'swap', title: '入れ替える', todo: '別の質問で通しで1本。選んだ点が保てているかを見る。', action: 'interview' },
  { id: 'gym', title: `${LABELS.gym.name}（弱い段階）`, todo: 'ウォームアップの強さで、手ごわい面接官を体験する。', action: 'gym' },
  { id: 'full', title: '本番の条件で通し', todo: '時間を計り、質問の順番を決めずに通しで1本。', action: 'interview' },
  { id: 'light', title: '軽く思い出す', todo: '短時間。質問カードを見て、要点を思い出す。新しいことは足さない。', action: 'recall' },
];
export const MIN_DAYS = 2;
export const MAX_DAYS = 30;

export const WARMUP_NOTES = [
  'この7つの並びは、研究の直接の裏付けが無い仮説です。「7日で自信がつく」とは言えません。',
  '画面に出す成果は、あなた自身の1回目と最終回の点の差だけです。',
  '間隔を空けた練習と、見ずに思い出す練習が効くという研究はありますが、事実を覚える課題のものです。面接の練習で同じとは限りません。',
];

export const FEEDBACK_LAYERS = [
  '1問ごと: 答えた直後に、短く事実と行動だけを返します（結果の画面の質問別カード）。',
  '終了時: 6軸の点と理由を、説明つきで返します。',
  '翌日: 同じ質問にもう一度挑戦します（2つ目の練習）。',
];

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); };
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
export const todayString = (now = new Date()) => fmtDate(now);

/**
 * 本番までの日数 D に合わせて、7つの練習を並べる。
 *  - D が7以上: 7回に分け、最初を今日、最後を本番の前日に置き、間を等間隔にする（間隔は約 (D-1)/6 日）。
 *  - D が7未満: 練習の順序は保ったまま、D日に詰める（同じ日に複数の練習が入る）。最後の日が本番の前日。
 * @returns {Array<{n: number, offset: number, steps: string[]}>}
 */
export function buildSchedule(daysToReal) {
  const d = daysToReal;
  if (!Number.isInteger(d) || d < MIN_DAYS || d > MAX_DAYS) throw new HttpError(400, `本番までの日数は ${MIN_DAYS}〜${MAX_DAYS} 日の整数`);
  if (d >= STEPS.length) {
    return STEPS.map((s, i) => ({ n: i + 1, offset: Math.round((i * (d - 1)) / (STEPS.length - 1)), steps: [s.id] }));
  }
  const days = Array.from({ length: d }, () => []);
  STEPS.forEach((s, i) => days[Math.floor((i * d) / STEPS.length)].push(s.id));
  return days.map((steps, i) => ({ n: i + 1, offset: i, steps }));
}

export function scheduleNote(daysToReal, schedule) {
  if (daysToReal < STEPS.length) return `本番まで${daysToReal}日なので、7つの練習を${daysToReal}日に詰めています。同じ日の練習は、上から順に行います。`;
  const gap = (daysToReal - 1) / (STEPS.length - 1);
  return `本番まで${daysToReal}日なので、練習の間隔を約${Math.round(gap * 10) / 10}日にしています（本番までの日数の約${Math.round((gap / daysToReal) * 100)}%）。最後の練習は本番の前日です。`;
}

const text = (v, name, max) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || [...v].length > max) throw new HttpError(400, `${name} は${max}字以内の文字列`);
  return v.trim();
};

/** 計画を作る（純関数）。intention は「いつ・どこで」を決める実行意図。 */
export function createPlan({ today, daysToReal, intention = {} }) {
  const schedule = buildSchedule(daysToReal);
  return {
    version: 1,
    createdAt: today,
    startDate: today,
    daysToReal,
    realDate: addDays(today, daysToReal),
    intention: { when: text(intention.when, 'when', 40), where: text(intention.where, 'where', 40) },
    note: scheduleNote(daysToReal, schedule),
    sessions: schedule.map((s) => ({ ...s, date: addDays(today, s.offset), done: null })),
  };
}

/** n 回目の実施を記録する（上書き可）。confidence は 1〜5 の自己申告、sessionId は紐づける面接（任意）。 */
export function recordDone(plan, n, { confidence, sessionId = null, at }) {
  if (!plan?.sessions?.some((s) => s.n === n)) throw new HttpError(404, 'その回は計画に無い');
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) throw new HttpError(400, 'confidence は 1〜5 の整数');
  if (sessionId !== null && typeof sessionId !== 'string') throw new HttpError(400, 'sessionId が不正');
  return { ...plan, sessions: plan.sessions.map((s) => (s.n === n ? { ...s, done: { at, confidence, sessionId } } : s)) };
}

export function clearDone(plan, n) {
  if (!plan?.sessions?.some((s) => s.n === n)) throw new HttpError(404, 'その回は計画に無い');
  return { ...plan, sessions: plan.sessions.map((s) => (s.n === n ? { ...s, done: null } : s)) };
}

/** 面接の6軸の点（meta.scores）から、100点換算。取れなければ null。 */
export const pointsOf = (scores) => rankFromScores(scores)?.points ?? null;

/**
 * 画面用。各回の状態（done / today / late / upcoming）、自信度と点、1回目と最終回の差を付ける。
 * @param {object|null} plan
 * @param {string} today YYYY-MM-DD
 * @param {(sessionId: string) => number|null} pointsFor 紐づけた面接の100点換算
 */
export function planView(plan, today, pointsFor = () => null) {
  if (!plan) return null;
  const since = daysBetween(plan.startDate, today);
  const sessions = plan.sessions.map((s) => {
    const status = s.done ? 'done' : s.offset === since ? 'today' : s.offset < since ? 'late' : 'upcoming';
    return { ...s, status, steps: s.steps.map((id) => STEPS.find((x) => x.id === id)), points: s.done?.sessionId ? pointsFor(s.done.sessionId) : null };
  });
  const current = sessions.find((s) => s.status !== 'done' && s.status !== 'upcoming') ?? sessions.find((s) => s.status === 'upcoming') ?? null;
  const first = sessions[0];
  const last = sessions.at(-1);
  const both = sessions.length > 1 && first.points != null && last.points != null;
  return {
    ...plan,
    sessions,
    sinceStart: since,
    daysLeft: Math.max(0, daysBetween(today, plan.realDate)),
    current: current ? current.n : null,
    allDone: sessions.every((s) => s.status === 'done'),
    diff: both ? { first: first.points, last: last.points, delta: last.points - first.points } : null,
    notes: WARMUP_NOTES,
    layers: FEEDBACK_LAYERS,
  };
}
