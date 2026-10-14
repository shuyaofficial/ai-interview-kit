// 逐語録を「やりとり」（面接官の質問 + 応募者の回答）に区切る。面接中に1問ずつ採点するための土台。
// 区切り方: 応募者の回答がある状態で、面接官が「質問文で終わる発話」を言い終えたら、それまでを1つのやりとりとして閉じる。
// 相づち・移行・締めの言葉（質問文で終わらない発話）は閉じず、直前のやりとりに付ける。
// 深掘りの往復を1つに束ねるかは判定が割れるので、迷ったときは1往復ずつ区切る（質問文なら必ず区切る）。

const ENDINGS = ['？', '\\?', 'か', 'ください', '下さい', 'お聞かせ', 'お話し', '教えて', '聞かせて', '話して'];
// 「よろしくお願いします」は挨拶で、質問ではない
const ASK = '(?<!よろしく)お願い(?:します|致します|いたします)';
const QUESTION_END = new RegExp(`(?:${ENDINGS.join('|')}|${ASK})[。．.！!？?」』\\s]*$`);

/** 面接官の発話が質問（回答を求める文）で終わっているか。 */
export function endsWithQuestion(text) {
  return QUESTION_END.test(String(text ?? '').trim());
}

const norm = (s) => String(s ?? '').replace(/[\s　]+/g, '');

function build(index, turns) {
  const firstCand = turns.findIndex((t) => t.role === 'candidate');
  const lead = turns.slice(0, firstCand).reverse().find((t) => t.role === 'interviewer') ?? turns[0];
  return { index, turns: turns.map((t) => ({ ...t })), question: lead.text, questionStartMs: lead.startMs };
}

/** 同じやりとりかを見分けるキー（面接中に採点した結果を終了時に使い回すため）。 */
export function exchangeKey(ex) {
  return ex.turns.map((t) => `${t.role === 'candidate' ? 'C' : 'I'}${norm(t.text)}`).join('|');
}

/** 発話が1つ完了するたびに push する。やりとりが閉じたらそれを返す（まだなら null）。flush() は面接終了時の残り。 */
export function createExchangeTracker() {
  let pending = [];
  let count = 0;
  const hasAnswer = () => pending.some((t) => t.role === 'candidate');
  const close = () => {
    const ex = build(count, pending);
    count += 1;
    return ex;
  };
  return {
    push(turn) {
      if (turn.role === 'interviewer' && hasAnswer() && endsWithQuestion(turn.text)) {
        const closed = close();
        pending = [turn];
        return closed;
      }
      pending = [...pending, turn];
      return null;
    },
    flush() {
      if (!hasAnswer()) return null;
      const ex = close();
      pending = [];
      return ex;
    },
  };
}

/** 逐語録全体を区切る（純関数）。応募者が1度も答えていない質問は、やりとりにならない。 */
export function splitExchanges(turns) {
  const tracker = createExchangeTracker();
  const out = [];
  for (const t of turns) {
    const ex = tracker.push(t);
    if (ex) out.push(ex);
  }
  const last = tracker.flush();
  return last ? [...out, last] : out;
}

/** プロンプト用。応募者の発言に引用できるよう、番号を付けて並べる。 */
export function exchangeText(ex) {
  return ex.turns.map((t, i) => `${i}: ${t.role}: ${t.text}`).join('\n');
}
