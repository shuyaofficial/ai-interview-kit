// gym（手ごわい面接官の練習）の採点（通常の6軸に足す練習の目安）。
//  - 立て直しの速さ: 答え始めるまでの秒と言いよどみの数。LLM を使わず、逐語録の時刻と文字列から決定論で計算する。
//  - 切り返しの型（事実・責任・更新）: LLM が判定し、引用を逐語録と突き合わせて確かめる。
import { fillTemplate, loadPrompt } from './interview.mjs';
import { esText, noEsRule, transcriptText, loadSchema, countFillers, norm } from './scoring.mjs';
import { gymLabel } from './gym.mjs';
import { LABELS } from '../web/js/labels.mjs';

const TEMPLATE = loadPrompt('gym-score');
const round1 = (n) => Math.round(n * 10) / 10;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const PARTS = ['fact', 'responsibility', 'update'];
/** 答え始めるまでが、この秒数以上なら「間が長め」と数える（目安）。 */
export const SLOW_START_SEC = 5;

/**
 * 面接官の発言の直後に始まった応募者の回答ごとに、答え始めるまでの秒と言いよどみ数を出す。純関数。
 * 面接官の発言が終わる前に話し始めた（遮った）回答は、秒を 0 として overlap:true を付ける。
 */
export function computeRecovery(turns) {
  const answers = [];
  turns.forEach((t, turn) => {
    const prev = turns[turn - 1];
    if (t.role !== 'candidate' || prev?.role !== 'interviewer') return;
    const raw = (t.startMs - prev.endMs) / 1000;
    answers.push({
      turn,
      startSec: round1(Math.max(0, raw)),
      overlap: raw < 0,
      fillers: sum(Object.values(countFillers(t.text))),
      chars: t.text.replace(/\s+/g, '').length,
    });
  });
  const n = answers.length;
  const starts = answers.map((a) => a.startSec);
  return {
    answers,
    count: n,
    avgStartSec: n ? round1(sum(starts) / n) : null,
    maxStartSec: n ? Math.max(...starts) : null,
    slowCount: answers.filter((a) => a.startSec >= SLOW_START_SEC).length,
    totalFillers: sum(answers.map((a) => a.fillers)),
    fillersPerAnswer: n ? round1(sum(answers.map((a) => a.fillers)) / n) : null,
    slowStartSec: SLOW_START_SEC,
  };
}

/** 面接官の発言 turn の直後に続く、応募者の連続した発言（次の面接官の発言の手前まで）。 */
function answerTurns(turns, turn) {
  const out = [];
  for (let i = turn + 1; i < turns.length && turns[i].role === 'candidate'; i += 1) out.push(turns[i]);
  return out;
}

/**
 * LLM の判定を逐語録に突き合わせる。引用が応募者の回答に無い「満たした」は満たしていないことにし、quoteInvalid を付ける。
 * 面接官の発言でない turn・回答が無い質問は捨てる。
 */
export function validateRebuttals(result, turns) {
  const items = [];
  for (const r of result?.rebuttals ?? []) {
    const asked = turns[r.turn];
    const answers = asked?.role === 'interviewer' ? answerTurns(turns, r.turn) : [];
    if (!answers.length) continue;
    const body = norm(answers.map((t) => t.text).join(''));
    const item = { turn: r.turn, question: r.question || asked.text, comment: r.comment ?? '' };
    for (const p of PARTS) {
      const part = r[p] ?? { met: false, quote: '' };
      const q = norm(part.quote);
      const valid = Boolean(q) && body.includes(q);
      item[p] = part.met && valid ? { met: true, quote: part.quote } : { met: false, quote: '', ...(part.met && !valid ? { quoteInvalid: true } : {}) };
    }
    item.complete = PARTS.every((p) => item[p].met);
    items.push(item);
  }
  return {
    rebuttals: items,
    summary: result?.summary ?? '',
    asked: items.length,
    complete: items.filter((x) => x.complete).length,
    counts: Object.fromEntries(PARTS.map((p) => [p, items.filter((x) => x[p].met).length])),
  };
}

export function buildGymScorePrompt(es, turns, type, level) {
  return fillTemplate(TEMPLATE, { gymName: LABELS.gym.name, gymLabel: gymLabel(type, level), noEsRule: noEsRule(es), es: esText(es), transcript: transcriptText(turns) });
}

/** run は ({prompt, schema}) => Promise<object>（llm.runStructured を kind:'gym' で包んだもの）。 */
export async function scoreRebuttals({ es, turns, type, level, run }) {
  const raw = await run({ prompt: buildGymScorePrompt(es, turns, type, level), schema: loadSchema('gym-score') });
  if (!raw || !Array.isArray(raw.rebuttals)) throw new Error('gym-score の結果の形が不正');
  return validateRebuttals(raw, turns);
}

/** 練習の目安一式。切り返しの型が失敗しても、立て直しの速さは返す。 */
export async function scoreGym({ es, turns, type, level, run }) {
  const recovery = computeRecovery(turns);
  try {
    return { recovery, rebound: await scoreRebuttals({ es, turns, type, level, run }), error: null };
  } catch (e) {
    return { recovery, rebound: null, error: `切り返しの型を判定できなかった: ${e.message}` };
  }
}
