// 採点まわりの純関数（プロンプトの部品・話し方の目安・引用検証・禁止語チェック）。ファイルも LLM も触らない。
// Node のサーバーは scoring.mjs 経由で、Cloudflare の Functions とブラウザはこのファイルを直接読む。
import { axesFor, AXIS_IDS, FORBIDDEN_WORDS, ABUSE_WORDS, SPEECH_GUIDE } from './rubric.mjs';
import { itemsText, hasEs } from './es.mjs';

/** 採点プロンプトの評価軸と尺度。ids を渡すと、その軸だけ（1 話題の練習で見る軸）。 */
export function axesText(es = null, ids = null) {
  return axesFor(es ? !hasEs(es) : false).filter((a) => !ids || ids.includes(a.id)).map((a) => {
    const anchors = [1, 2, 3, 4, 5].map((n) => `  ${n}: ${a.anchors[n]}`).join('\n');
    return `## ${a.id}（${a.label}）\n見るところ: ${a.looksAt}\n${anchors}`;
  }).join('\n\n');
}

const unset = (v) => (String(v ?? '').trim() ? v : '（未入力）');

/** ES が無い面接のときだけ入る、採点側の読み替え。ES がある面接では空文字（プロンプトは従来と同じ）。 */
export function noEsRule(es) {
  if (hasEs(es)) return '';
  return `# ES が無い面接の読み替え
この面接では ES が提出されていない。次のとおり読み替える。
- 「ES との食い違い」「ES の事実」は無いものとして扱う。回答どうしの食い違いと、深掘りに答えが崩れないかだけを見る。
- consistency（一貫性）軸は、回答どうしの整合と深掘りへの耐性だけで評価する。ES が無いことを減点しない。
- 応募者が読む文（reason, good, improve, modelAnswer, summary, nextPractice など）で、ES に触れない。「ESに書いていない」「ESと比べて」などと書かない。modelAnswer は応募者が話した事実だけを使う。

`;
}

export function esText(es) {
  const head = `企業: ${unset(es.company)} / 業界: ${unset(es.industry)} / 職種: ${unset(es.role)}`;
  if (!hasEs(es)) return `${head}\nESは提出されていません。`;
  if (es.items) return `${head}\n${itemsText(es)}`;
  return [
    head,
    `## 学生時代に力を入れたこと\n${es.gakuchika}`,
    `## 自己PR\n${es.selfPr}`,
    `## 志望動機\n${es.motivation}`,
  ].join('\n');
}

export function transcriptText(turns) {
  return turns.map((t, i) => `${i}: ${t.role}: ${t.text}`).join('\n');
}


// ---- 話し方の目安（採点外）----

const FILLERS_LONGEST_FIRST = [...SPEECH_GUIDE.fillers].sort((a, b) => b.length - a.length);
const FILLER_RE = new RegExp(FILLERS_LONGEST_FIRST.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

/** text 中のフィラーを最長一致・重複なしで数える。 */
export function countFillers(text) {
  const byWord = Object.fromEntries(SPEECH_GUIDE.fillers.map((w) => [w, 0]));
  for (const m of text.matchAll(FILLER_RE)) byWord[m[0]] += 1;
  return byWord;
}

export const fillerRegex = () => new RegExp(FILLER_RE.source, 'g');

const round1 = (n) => Math.round(n * 10) / 10;
const countChars = (s) => s.replace(/\s+/g, '').length;

/**
 * 候補者の各回答の字数・秒・字/分、フィラー出現数、ターン間の最長沈黙。純関数。
 * 沈黙は隣り合うターンの (次の startMs − 前の endMs)。
 */
export function computeSpeechMetrics(turns) {
  const answers = [];
  const byWord = Object.fromEntries(SPEECH_GUIDE.fillers.map((w) => [w, 0]));
  turns.forEach((t, turn) => {
    if (t.role !== 'candidate') return;
    const chars = countChars(t.text);
    const sec = (t.endMs - t.startMs) / 1000;
    const fillers = countFillers(t.text);
    for (const [w, n] of Object.entries(fillers)) byWord[w] += n;
    answers.push({
      turn,
      chars,
      sec: round1(sec),
      charsPerMin: sec > 0 ? round1((chars / sec) * 60) : null,
      fillerCount: Object.values(fillers).reduce((a, b) => a + b, 0),
    });
  });
  const totalChars = answers.reduce((a, x) => a + x.chars, 0);
  const totalSec = turns.filter((t) => t.role === 'candidate').reduce((a, t) => a + (t.endMs - t.startMs) / 1000, 0);
  let longest = { sec: 0, afterTurn: null };
  for (let i = 1; i < turns.length; i += 1) {
    const gap = (turns[i].startMs - turns[i - 1].endMs) / 1000;
    if (gap > longest.sec) longest = { sec: round1(gap), afterTurn: i - 1 };
  }
  return {
    answers,
    totalChars,
    totalSec: round1(totalSec),
    charsPerMin: totalSec > 0 ? round1((totalChars / totalSec) * 60) : null,
    guideCharsPerMin: SPEECH_GUIDE.charsPerMinute,
    fillers: { total: Object.values(byWord).reduce((a, b) => a + b, 0), byWord },
    longestSilence: longest,
  };
}

// ---- 引用検証 ----

export const norm = (s) => String(s ?? '').replace(/[\s　]+/g, '');

/**
 * evidence.quote は turn 番号の candidate 発言に、questions[].quote は questionTurn 以降の
 * candidate 発言のどれかに、空白除去後の部分一致で含まれる必要がある。違反のリストを返す（無ければ []）。
 */
export function validateEvidence(result, turns) {
  const violations = [];
  for (const ax of result.axes ?? []) {
    for (const ev of ax.evidence ?? []) {
      const t = turns[ev.turn];
      const q = norm(ev.quote);
      let reason = null;
      if (!t) reason = `turn ${ev.turn} が存在しない`;
      else if (t.role !== 'candidate') reason = `turn ${ev.turn} は応募者の発言ではない`;
      else if (!q) reason = 'quote が空';
      else if (!norm(t.text).includes(q)) reason = `turn ${ev.turn} の発言に含まれない`;
      if (reason) violations.push({ kind: 'axis', axis: ax.axis, turn: ev.turn, quote: ev.quote, reason });
    }
  }
  for (const qu of result.questions ?? []) {
    const q = norm(qu.quote);
    const start = Number.isInteger(qu.questionTurn) ? qu.questionTurn : 0;
    const ok = q && turns.some((t, i) => i >= start && t.role === 'candidate' && norm(t.text).includes(q));
    if (!ok) {
      violations.push({
        kind: 'question', questionTurn: qu.questionTurn, quote: qu.quote,
        reason: q ? `turn ${qu.questionTurn} 以降の応募者の発言に含まれない` : 'quote が空',
      });
    }
  }
  return violations;
}

/**
 * 面接官（interviewer）の発言に禁止語があるかの決定論チェック。14事項の代表語に加えて、
 * 侮辱・外見・出身・性的な内容・脅しの語も拾う（category を付ける。14事項の語は category なし）。
 */
export function scanForbidden(turns) {
  const found = [];
  turns.forEach((t, turn) => {
    if (t.role !== 'interviewer') return;
    for (const w of FORBIDDEN_WORDS) {
      if (t.text.includes(w)) found.push({ turn, quote: t.text, topic: w, source: 'rule' });
    }
    for (const [category, words] of Object.entries(ABUSE_WORDS)) {
      for (const w of words) {
        if (t.text.includes(w)) found.push({ turn, quote: t.text, topic: w, category, source: 'rule' });
      }
    }
  });
  return found;
}

// ---- 採点 ----

/** axisIds は採点結果に必須の軸（既定は 6 軸すべて。1 話題の練習は、その話題で見る軸だけを渡す）。 */
export function assertScoringShape(result, axisIds = AXIS_IDS) {
  const ids = (result?.axes ?? []).map((a) => a.axis);
  const missing = axisIds.filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`採点結果に軸が足りない: ${missing.join(',')}`);
}

export function retryNote(violations) {
  const lines = violations.map((v) => {
    const where = v.kind === 'axis' ? `軸 ${v.axis} の evidence（turn ${v.turn}）` : `questions（questionTurn ${v.questionTurn}）の quote`;
    return `- ${where}: 「${v.quote}」→ ${v.reason}`;
  });
  return `\n\n# 前回の採点の引用違反（直して再採点する）\n次の引用は逐語録の応募者の発言に一字一句は存在しなかった。該当 turn の text から、そのままコピーした部分文字列に差し替えること。他の判断は変えなくてよい。\n${lines.join('\n')}\n`;
}

export const dedupe = (list) => list.filter((v, i) => list.findIndex((w) => w.turn === v.turn && w.topic === v.topic) === i);
