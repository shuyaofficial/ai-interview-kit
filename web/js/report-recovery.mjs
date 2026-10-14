// 採点が失敗したときのやり直し: 総評をもう一度作る / 採点できなかった質問をもう一度採点する。
import { h, clip } from './dom.mjs';
import { api } from './state.mjs';

/** やり直すものが無ければ null。onRetry は POST のあとに呼ぶ（結果画面を取り直す）。 */
export function renderRecovery(s, onRetry) {
  const finalFailed = s.status === 'error' && Boolean(s.transcript);
  const failedQs = s.status === 'scoring' ? [] : (s.scoring?.exchanges ?? []).filter((e) => e.status === 'error');
  if (!finalFailed && !failedQs.length) return null;
  const post = async (btn, path) => {
    btn.disabled = true;
    try { await api(path, { method: 'POST', body: {} }); } catch (e) { btn.after(h('span', { class: 'error', role: 'alert', text: `やり直せませんでした: ${e.message}` })); }
    onRetry();
  };
  const finalBtn = finalFailed ? h('button', { type: 'button', class: 'primary retry', id: 'btn-final-retry', text: '総評をもう一度作る' }) : null;
  finalBtn?.addEventListener('click', () => post(finalBtn, `/api/sessions/${s.id}/final/retry`));
  return h('div', { class: 'recover', role: 'group', 'aria-label': '採点のやり直し' },
    finalFailed ? [h('p', { text: '総評の作成に失敗しました。済んだ質問の採点は使い回して、総評だけを作り直します。' }), finalBtn] : null,
    failedQs.length ? [
      h('p', { text: '採点できなかった質問があります。' }),
      h('ul', {}, failedQs.map((e) => {
        const b = h('button', { type: 'button', class: 'retry retry-q', text: 'この質問をもう一度採点' });
        b.addEventListener('click', () => post(b, `/api/sessions/${s.id}/exchanges/${e.index}/retry`));
        return h('li', {}, h('span', { text: `${e.index + 1}. ${clip(e.question, 60)}` }), b);
      })),
    ] : null);
}
