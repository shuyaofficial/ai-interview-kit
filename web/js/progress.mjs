// 進み具合の計算と表示。進み具合は「経過時間 ÷ 過去の平均時間」を主にし、文字が届き始めたら文字数で補正する。95% で止める。
import { h, meterBar, setBar } from './dom.mjs';

const CAP = 0.95;

/** 取得してからの経過を足した、その処理の経過秒。 */
export function elapsedNow(piece, fetchedAt) {
  if (piece.status !== 'running') return piece.elapsedSec ?? 0;
  return (piece.elapsedSec ?? 0) + (performance.now() - fetchedAt) / 1000;
}

/** 0〜1。完了=1、待ち・失敗=0。 */
export function pieceProgress(piece, fetchedAt, expectedSec, expectedChars = null) {
  if (piece.status === 'done' || piece.status === 'skipped') return 1;
  if (piece.status !== 'running') return 0;
  const byTime = Math.min(CAP, elapsedNow(piece, fetchedAt) / Math.max(1, expectedSec));
  if (piece.chars > 0 && expectedChars) return Math.min(CAP, piece.chars / expectedChars);
  return byTime;
}

/** まだ終わっていない処理の中で、いちばん遅く終わりそうなものまでの秒（最低 2 秒）。全部終わっていれば 0。 */
export function remainingSec(pieces, fetchedAt, expectedSecOf) {
  const open = pieces.filter((p) => ['running', 'pending', 'queued', 'idle'].includes(p.status));
  if (!open.length) return 0;
  const left = open.map((p) => (p.status === 'running' ? expectedSecOf(p) - elapsedNow(p, fetchedAt) : expectedSecOf(p)));
  return Math.max(2, Math.round(Math.max(...left)));
}

export const remainingText = (sec) => `残り約${sec}秒`;

/** 細い進み具合のバー。data-bar を持たせ、ticker が幅を更新する。 */
export function progressBar(key, label = '進み具合') {
  const bar = meterBar('pbar bar', 0);
  bar.dataset.bar = key;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', label);
  return bar;
}

/** root の中の [data-bar] の幅を、compute(key) の値（0〜1）で更新する。 */
export function paintBars(root, compute) {
  for (const bar of root.querySelectorAll('[data-bar]')) setBar(bar, compute(bar.dataset.bar) * 100);
}

export function startTicker(timers, fn, ms = 300) {
  clearInterval(timers.tick);
  timers.tick = setInterval(fn, ms);
}

/** 上部の全体進行: 「N件中M件完了・残り約S秒」と全体バー。 */
export function summaryLine({ done, total, remaining }) {
  if (done >= total) return h('span', { text: `${total}件すべて完了しました` });
  return h('span', { text: `${total}件中${done}件完了${remaining ? `・${remainingText(remaining)}` : ''}` });
}
