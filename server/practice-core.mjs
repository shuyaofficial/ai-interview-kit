// 面接の種類（5分の練習 / 15分の通し）と、5分の練習の話題・面接官プロンプト・採点の読み替え。純関数だけ（ファイルを読まない）。
// Cloudflare の Functions とブラウザが読む（Node 版の server/ は使わない）。回数・時間・費用の数値は cloud/functions/_lib/config.mjs の 1 か所。
// 5分の練習の面接官は、今の面接官の流儀（interview-core.mjs・question-bank.json の段階）を、1 話題・約5分に絞ったもの。
import { fillTemplate, forbiddenText, focusPointsText, adaptBank, employerText, roleLine, companyNote, PAST_RULE } from './interview-core.mjs';
import { itemsText, hasEs } from './es.mjs';
import { AXIS_IDS } from './rubric.mjs';
import { esText, axesText, noEsRule, transcriptText } from './scoring-core.mjs';
import { qSummaryText } from './live-scoring-core.mjs';

/** 面接の種類。baseMin は画面・時間の上限の元になる分数（15分の通しは質問データ側の durationMin が優先される）。 */
export const KINDS = Object.freeze({
  short: Object.freeze({ id: 'short', label: '5分の練習', baseMin: 5 }),
  full: Object.freeze({ id: 'full', label: '15分の通し', baseMin: 15 }),
});
export const KIND_IDS = Object.freeze(Object.keys(KINDS));
export const isKind = (v) => typeof v === 'string' && KIND_IDS.includes(v);
/** 古い記録（種類を持たない）は 15分の通し。 */
export const kindOfRecord = (rec) => (isKind(rec?.kind) ? rec.kind : 'full');

export const NOT_OBSERVED_TEXT = 'この練習では見ていません';

const SKILLS = ['structure', 'specificity', 'responsiveness'];
/**
 * 5分の練習の話題。stage は question-bank.json（一次）の段階の id、axes はその話題で評価できる軸。
 * ここに無い軸は採点しない（「この練習では見ていません」と出し、平均にも入れない）。根拠は question-bank.json の各質問の axes の和集合。
 */
export const TOPICS = Object.freeze([
  { id: 'intro', label: '自己紹介', stage: 'intro', axes: SKILLS, purpose: '話の入りと所属・関心を、簡潔に伝えられるかを確かめる。' },
  { id: 'gakuchika', label: 'ガクチカ', stage: 'gakuchika', axes: [...SKILLS, 'ownership', 'consistency'], purpose: '取り組みの過程と本人の判断・行動が、仕事に活きる形で語れるかを確かめる。' },
  { id: 'self_pr', label: '自己PR', stage: 'self_pr', axes: [...SKILLS, 'ownership', 'consistency'], purpose: '強みを、場面と事実で裏づけて、仕事でどう活きるかまで語れるかを確かめる。' },
  { id: 'motivation', label: '志望動機', stage: 'motivation', axes: [...SKILLS, 'consistency', 'motivation'], purpose: 'その会社・職種でなければならない理由を、自分の経験と結びつけて語れるかを確かめる。' },
  { id: 'reverse', label: '逆質問', stage: 'reverse', axes: ['specificity', 'ownership', 'motivation', 'responsiveness'], purpose: '企業研究の深さと、質問の具体性・入社への意欲を確かめる。' },
  { id: 'es_item', label: 'ESの設問', stage: null, needsEs: true, axes: [...SKILLS, 'ownership', 'consistency'], purpose: 'ES に書いた内容を、本人の言葉で事実どおりに説明でき、深掘りに耐えるかを確かめる。' },
]);
export const TOPIC_IDS = Object.freeze(TOPICS.map((t) => t.id));
export const topicOf = (id) => TOPICS.find((t) => t.id === id) ?? null;

/** その話題で採点する軸（rubric の並び順）と、見ない軸。 */
export const observedAxes = (topicId) => AXIS_IDS.filter((id) => topicOf(topicId)?.axes.includes(id));
export const unobservedAxes = (topicId) => AXIS_IDS.filter((id) => !observedAxes(topicId).includes(id));

const ES_ITEM_QUESTIONS = [
  { text: 'ESに書いた内容を、1分程度で説明してください。', intent: 'ES の記述を本人の言葉で説明でき、事実が合っているかを確かめる。' },
  { text: 'その中で、あなた自身が具体的にしたことは何ですか。', intent: '本人の判断と行動を「私は」で語れるかを見る。' },
  { text: 'その結果はどうなりましたか。数字で示せるものがあれば教えてください。', intent: '行動と結果のつながりと、数字での裏づけを見る。' },
];
const ES_ITEM_FOLLOWUPS = ['なぜそうしたのですか。', '具体的には、どの場面のことですか。', '他の選択肢は考えませんでしたか。', 'そこから何を学びましたか。'];

/** 面接官に締めを促すテキスト（終了の少し前にブラウザが Gemini Live へ送る）。 */
export function wrapUpText(kind, wrapUpSec = 30) {
  const noun = kind === 'short' ? '練習' : '面接';
  return `（面接官への指示です。応募者の発言ではありません。残りあと${wrapUpSec}秒です。いま聞いている点は、応募者の答えを受けたうえで、新しい質問はせず、「本日の${noun}は以上です。お疲れさまでした」と言って終えてください。）`;
}

/** 接続直後にこちらから渡す開始の合図。5分の練習は、その話題の最初の質問から始める。 */
export function kickoffText(kind, topicId, itemTitle = '') {
  if (kind !== 'short') return null; // 15分の通しは interview-core の KICKOFF_TEXT
  const label = topicId === 'es_item' ? `ESの設問「${itemTitle}」` : topicOf(topicId).label;
  return `（応募者が入室し、着席しました。短く挨拶をして、「${label}」の最初の質問をしてください。ほかの話題には広げません。）`;
}

/** 15分の通し用の、時間の合図の説明（共通テンプレートの interviewer.md には書けないので、サーバーが後ろに足す）。 */
export const FULL_TIME_NOTE = '\n\n# 時間の合図\n時間はシステムが管理します。「残りあと◯秒です」という括弧書きの指示が来たら、それは面接官への指示です（応募者の発言ではありません）。新しい質問はせず、締めの言葉を言って終えてください。\n';

function targetOf(es, topicId, itemId) {
  if (topicId === 'es_item') {
    const item = es.items?.find((it) => it.id === itemId);
    if (!item) throw new Error('ESの設問が見つからない');
    return { label: `ESの設問「${item.title}」`, item, questions: ES_ITEM_QUESTIONS, followups: ES_ITEM_FOLLOWUPS };
  }
  return null;
}

/**
 * 5分の練習の面接官プロンプト。純関数。rawBank は一次（first）の質問データ、template は interviewer-short.md。
 * topicId は TOPICS の id、itemId は es_item のときの設問 id、limitMin は時間の上限（分）。
 */
export function buildShortPrompt(es, plan, rawBank, template, { topicId, itemId = null, limitMin = KINDS.short.baseMin }) {
  const topic = topicOf(topicId);
  if (!topic) throw new Error('話題が不正');
  if (topic.needsEs && !hasEs(es)) throw new Error('ESの設問にはESが要る');
  const bank = adaptBank(rawBank, es);
  const stage = topic.stage ? bank.stages.find((s) => s.id === topic.stage) : null;
  if (topic.stage && !stage) throw new Error('質問データに話題の段階が無い');
  const target = targetOf(es, topicId, itemId);
  const questions = stage ? stage.questions.map((q) => ({ text: q.text, intent: q.intent })) : target.questions;
  const followups = [...new Set(stage ? stage.questions.flatMap((q) => q.followups ?? []) : target.followups)].slice(0, 6);
  const noEs = !hasEs(es);
  const midcareer = es.mode === 'midcareer';
  const others = TOPICS.filter((t) => t.id !== topicId && !(t.needsEs && noEs)).map((t) => t.label).join('・');
  return fillTemplate(template, {
    employer: employerText(es),
    hiringKind: midcareer ? '中途' : '新卒',
    roleLine: roleLine(es),
    limitMin,
    topicLabel: target?.label ?? topic.label,
    topicPurpose: topic.purpose,
    firstQuestion: questions[0].text,
    questions: questions.map((q) => `- ${q.text}（確かめること: ${q.intent}）`).join('\n'),
    followups: followups.map((f) => `  - ${f}`).join('\n'),
    otherTopics: others,
    pastRule: PAST_RULE[midcareer ? 'midcareer' : 'newgrad'],
    companyNote: topicId === 'motivation' ? companyNote(es) : '',
    forbidden: forbiddenText(),
    esItems: itemsText(es),
    targetItem: target ? `\n# 今回の対象の設問\n## ${target.item.title}\n${target.item.text.trim() ? target.item.text : '（未記入）'}\n` : '',
    focusHeading: noEs ? '深掘りする論点（一般的な論点）' : 'このESで深掘りする論点',
    focusPoints: focusPointsText(plan, es),
  });
}

/** 5分の練習の総評の採点プロンプト（final-short.md）を組む関数を返す。引数の並びは live-scoring-core の buildFinalPrompt と同じ（scoreFinal の buildPrompt に渡す）。 */
export function shortFinalPromptBuilder(topicId) {
  const topic = topicOf(topicId);
  if (!topic) throw new Error('話題が不正');
  const seen = observedAxes(topicId);
  return (es, turns, jobs, _modeInfo, template) => fillTemplate(template, {
    topicLabel: topic.label,
    observed: seen.join('、'),
    notObserved: unobservedAxes(topicId).join('、') || 'なし',
    noEsRule: noEsRule(es),
    axes: axesText(es, seen),
    forbidden: forbiddenText(),
    qsummary: qSummaryText(jobs),
    es: esText(es),
    transcript: transcriptText(turns),
  });
}
