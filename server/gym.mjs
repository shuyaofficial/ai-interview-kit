// gym（手ごわい面接官の練習）: 面接官のタイプと強さの定義、開始の検証（毎回の同意が必須）、面接官プロンプトの組み立て、不安の自己評価の扱い。
import { fillTemplate, loadPrompt, forbiddenText, stagesText, adaptBank, employerText, roleLine, companyNote, MODE_DEFAULTS } from './interview.mjs';
import { itemsText, hasEs } from './es.mjs';
import { LABELS } from '../web/js/labels.mjs';
import { ABUSE_LABELS, ABUSE_WORDS, FORBIDDEN_TOPICS } from './rubric.mjs';
import { HttpError } from './http-util.mjs';

export const GYM_TYPES = [
  { id: 'logic', label: '理詰め型', summary: '根拠・数字・定義を求め、回答どうしや ES との食い違いを突く。「なぜ」を3〜4回重ねる。', trains: '論理の一貫性、事実で答える力' },
  { id: 'pressure', label: '圧迫型', summary: '疑う口調で「それだけですか」と返す。間をあけたり、話を遮ったりする。', trains: '動揺したときに、事実・責任・その後の変化で返す力' },
  { id: 'silent', label: '無反応型', summary: '相づちを打たず、短い質問だけを続ける。', trains: '反応が無くても、自分で話を組み立てる力' },
  { id: 'timed', label: '時間制限型', summary: '「30秒で」「一言で」と答えの長さを区切る。', trains: '結論を先に言う力' },
];

export const GYM_LEVELS = [
  { id: 'warmup', label: 'ウォームアップ', summary: '丁寧に深掘りする。遮らず、沈黙も短い。', tendency: '「確認させてください」の形で、1つの話題を最大2回まで深掘りします。' },
  { id: 'normal', label: 'ふつう', summary: '論理の穴を指摘し、反論を入れる。', tendency: '回答の穴をはっきり指摘し、「しかし〜という見方もできます」と反論します。話を遮るのは1回までです。' },
  { id: 'worst', label: '本番最悪想定', summary: '圧の強い質問、長い沈黙、遮りが入る。', tendency: '厳しい質問、10秒ほどの沈黙、話を遮る場面が出ます。それでも人格・外見・出身への攻撃はしません。' },
];

export const HARD_KINDS = [
  { id: 'ability', label: '能力への懸念', example: '「ES の成果のうち、あなた自身が担った部分はどこですか」「失敗した経験を教えてください」', exampleNoEs: '「これまでの成果のうち、あなた自身が担った部分はどこですか」「失敗した経験を教えてください」' },
  { id: 'integrity', label: '誠実さへの懸念', example: '「ES の記述と、先ほどのお話に食い違いがあるように聞こえます。どちらが事実ですか」', exampleNoEs: '「先ほどのお話の中に、食い違いがあるように聞こえます。どちらが事実ですか」' },
];

/** 開始前・終了後の6項目の自己評価（各 1〜5）。診断ではなく、本人が変化を見るための目安。 */
export const ANXIETY_ITEMS = [
  '心臓がどきどきしている',
  '手や声が震えそうだ',
  'うまく話せない気がする',
  '悪く評価されるのが心配だ',
  '頭が真っ白になりそうだ',
  '逃げ出したい気持ちがある',
];
export const ANXIETY_SCALE = ['まったくない', '少しある', 'ある', 'かなりある', 'とてもある'];
/** 平均がこの値以上なら「強い不安」。次の段階を自動では勧めない（設計上の仮説）。 */
export const ANXIETY_STRONG = 3.5;

export const CONSULT_LINE = 'ここまでの圧は練習のための設定でした。実際の面接でこのような言動があったときは、労働局（雇用環境・均等室）や就活ハラスメント悩み相談室に相談できます。';

const hardQuestions = (withEs) => HARD_KINDS.map((k) => `   - ${k.label}: ${withEs ? k.example : k.exampleNoEs}`).join('\n');
const BASE = loadPrompt('gym-base');
const TYPE_FILES = Object.fromEntries(GYM_TYPES.map((t) => [t.id, loadPrompt(`gym-type-${t.id}`).trim()]));
const LEVEL_FILES = Object.fromEntries(GYM_LEVELS.map((l) => [l.id, loadPrompt(`gym-level-${l.id}`).trim()]));

export const gymType = (id) => GYM_TYPES.find((t) => t.id === id) ?? null;
export const gymLevel = (id) => GYM_LEVELS.find((l) => l.id === id) ?? null;
export const gymLabel = (type, level) => `${gymType(type)?.label ?? type}・${gymLevel(level)?.label ?? level}`;

/** 禁止する話題の一覧（人格・外見・出身への攻撃、性的な内容、脅し）。面接官プロンプトに入れる。 */
export function abuseRulesText() {
  return Object.keys(ABUSE_WORDS).map((k) => `  - ${ABUSE_LABELS[k]}（例: ${ABUSE_WORDS[k].slice(0, 4).map((w) => `「${w}」`).join('')}など）`).join('\n');
}

/** 純関数。es は normalizeEs の戻り値、bank は loadModeBank の戻り値。 */
export function buildGymPrompt({ es, bank: rawBank, type, level }) {
  if (!gymType(type) || !gymLevel(level)) throw new Error('gym の type / level が不正');
  const bank = adaptBank(rawBank, es);
  const withEs = hasEs(es);
  const mode = bank.mode ?? es.mode ?? 'first';
  const totalSec = bank.stages.reduce((sum, s) => sum + s.timeboxSec, 0);
  const contradiction = withEs
    ? '回答どうし、または ES の記述との食い違いを見つけたら、事実だけを指して確認する（例: 「先ほどは〇〇とのことでしたが、ES には△△とあります。どちらが正確ですか」）。'
    : '回答どうしの食い違いを見つけたら、事実だけを指して確認する（例: 「先ほどは〇〇とのことでしたが、今は△△とのことです。どちらが正確ですか」）。';
  return fillTemplate(BASE, {
    employer: employerText(es),
    roleLine: roleLine(es),
    companyNote: companyNote(es),
    topicSource: withEs ? '応募者の ES' : '応募者の自己紹介と回答の中身',
    rephraseTo: withEs ? 'ES' : '応募者の話',
    hiringKind: mode === 'midcareer' ? '中途' : '新卒',
    gymLabel: gymLabel(type, level),
    typeBehavior: fillTemplate(TYPE_FILES[type], { contradiction }),
    levelBehavior: LEVEL_FILES[level],
    totalMin: Math.round(totalSec / 60),
    hardQuestions: hardQuestions(withEs),
    stages: stagesText(bank),
    abuseRules: abuseRulesText(),
    forbidden: forbiddenText(),
    esItems: itemsText(es),
  });
}

/** 採点側に渡す面接の種類の表示名（q-score / final の「面接の種類」に入る）。 */
export function gymModeInfo(bank, type, level) {
  const base = bank?.label ?? MODE_DEFAULTS.first.label;
  return { ...bank, label: `${base}（${LABELS.gym.name}: ${gymLabel(type, level)}。面接官は意図的に厳しく振る舞う設定。応募者の回答の内容だけを見て採点する）` };
}

/** 6項目の自己評価の検証。各 1〜5 の整数を6個。不正なら 400。 */
export function parseAnxiety(v, name = 'anxiety') {
  const ok = Array.isArray(v) && v.length === ANXIETY_ITEMS.length && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  if (!ok) throw new HttpError(400, `${name} は 1〜5 の整数 ${ANXIETY_ITEMS.length} 個`);
  return v;
}
export const anxietyMean = (v) => Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;

/** 開始の本文の検証。同意は毎回必須（保存しない）。 */
export function parseGymStart(body) {
  if (body?.consent !== true) throw new HttpError(400, '開始前の確認への同意が必要です');
  if (!gymType(body.type)) throw new HttpError(400, 'type が不正');
  if (!gymLevel(body.level)) throw new HttpError(400, 'level が不正');
  const reappraisal = body.reappraisal == null ? '' : body.reappraisal;
  if (typeof reappraisal !== 'string' || [...reappraisal].length > 200) throw new HttpError(400, 'reappraisal は200字以内の文字列');
  return { type: body.type, level: body.level, anxietyBefore: parseAnxiety(body.anxiety), reappraisal: reappraisal.trim() };
}

/**
 * 終了後の案内。強い不安が出た人、途中で止めた人には、次の段階を自動では勧めない。
 * @returns {{suggest: string|null, note: string}}
 */
export function nextStepHint({ level, stopped, anxietyAfter }) {
  const strong = anxietyAfter && anxietyMean(anxietyAfter) >= ANXIETY_STRONG;
  if (strong) return { suggest: null, note: '今は不安が強く出ています。今日はここまでで十分です。次の段階を選ぶかどうかは、落ち着いてから自分で決めてください。' };
  if (stopped) return { suggest: null, note: '途中で止めたことは、減点にも記録の欠損にもなりません。次にやるときは、同じ強さか、より弱い強さから選べます。' };
  const next = GYM_LEVELS[GYM_LEVELS.findIndex((l) => l.id === level) + 1];
  if (!anxietyAfter) return { suggest: null, note: '終了後の自己評価を入れると、次の段階の目安が出ます。' };
  return { suggest: next?.id ?? null, note: next ? `不安は強く出ていません。次は「${next.label}」も選べます。選ぶかどうかは自分で決めてください。` : '同じ強さをもう一度やるか、別のタイプを試すかは、自分で決めてください。' };
}

export const STOP_REASONS = [
  { id: 'intense', label: '圧が強すぎた' },
  { id: 'tired', label: '疲れた・休みたい' },
  { id: 'other', label: 'そのほか' },
];

/** 終了後の記録（不安の自己評価・止めた理由・三人称ひとこと）の検証。 */
export function parseGymAfter(body) {
  const stopReason = body.stopReason ?? null;
  if (stopReason !== null && !STOP_REASONS.some((r) => r.id === stopReason)) throw new HttpError(400, 'stopReason が不正');
  const selfTalk = body.selfTalk ?? null;
  if (selfTalk !== null && typeof selfTalk !== 'boolean') throw new HttpError(400, 'selfTalk は true / false');
  return { anxietyAfter: parseAnxiety(body.anxiety), stopReason, selfTalk };
}

/** gym の記録の一覧と、三人称ひとことを使った回・使わなかった回の平均点の並び。 */
export function gymHistory(metas, pointsOf) {
  const items = metas.filter((m) => m.gym).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((m) => ({
    id: m.id, createdAt: m.createdAt, company: m.company, status: m.status,
    type: m.gym.type, level: m.gym.level, stopped: Boolean(m.gym.stopped), selfTalk: m.gym.selfTalk ?? null,
    points: m.scores ? pointsOf(m.scores) : null,
    anxietyBefore: m.gym.anxietyBefore ? anxietyMean(m.gym.anxietyBefore) : null,
    anxietyAfter: m.gym.anxietyAfter ? anxietyMean(m.gym.anxietyAfter) : null,
  })).filter((x) => x.status !== 'ready');
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const group = (flag) => {
    const rows = items.filter((x) => x.selfTalk === flag && x.points != null);
    return { n: rows.length, avgPoints: avg(rows.map((x) => x.points)) };
  };
  return { items, selfTalk: { used: group(true), notUsed: group(false) } };
}

/** /api/config に載せる、画面用の定義。 */
export function gymConfig() {
  return {
    types: GYM_TYPES, levels: GYM_LEVELS, hardKinds: HARD_KINDS, anxietyItems: ANXIETY_ITEMS, anxietyScale: ANXIETY_SCALE,
    stopReasons: STOP_REASONS, consultLine: CONSULT_LINE, strongAnxiety: ANXIETY_STRONG, forbiddenTopics: FORBIDDEN_TOPICS.map((t) => t.label),
    abuseLabels: Object.values(ABUSE_LABELS), defaultLevel: 'warmup',
  };
}
