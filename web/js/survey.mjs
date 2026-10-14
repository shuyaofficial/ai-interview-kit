// 感想アンケート: 使いやすさ（5段階）・使いやすかった点・使いにくかった点（画面や機能の選択＋自由記入。各 2000 字まで）。
// 「使いにくかった点を開発者に送る」（既定オン）の中身をその場で見せる。逐語録・ES・点数は送らない。自由記入は textContent だけで描く。
import { $, h } from './dom.mjs';
import { api, state, nav, show } from './state.mjs';
import { likert } from './forms.mjs';

const label = (id) => state.config.feedback.areas.find((a) => a.id === id)?.label ?? id;

function chips(name, onChange) {
  const boxes = state.config.feedback.areas.map((a) => {
    const input = h('input', { type: 'checkbox', name, value: a.id });
    input.addEventListener('change', onChange);
    return { input, el: h('label', { class: 'pick' }, input, h('span', { text: a.label })) };
  });
  return { el: h('div', { class: 'picks' }, boxes.map((b) => b.el)), picks: () => boxes.filter((b) => b.input.checked).map((b) => b.input.value) };
}

function freeText(id, onChange) {
  const max = state.config.feedback.maxChars;
  const area = h('textarea', { id, rows: 4, maxlength: String(max), 'aria-describedby': `${id}-n` });
  const count = h('p', { class: 'counter', id: `${id}-n` });
  const paint = () => { count.textContent = `${[...area.value].length} / ${max} 字`; };
  area.addEventListener('input', () => { paint(); onChange(); });
  paint();
  return { el: h('div', {}, area, count), text: () => area.value };
}

/** 送る中身。チェックが外れていれば、使いにくかった点は残さないと伝える。 */
function previewLines(rating, send, good, bad) {
  const lines = [`全体の使いやすさ: ${rating ? `${rating} / 5` : '（未回答）'}`];
  if (!send) return [...lines, '「使いにくかった点を開発者に送る」を外しているので、使いにくかった点は残しません。使いやすさの点数と使いやすかった点だけを残します。'];
  const part = (name, p) => `${name}: ${[p.picks.map(label).join('、'), p.text.trim()].filter(Boolean).join(' ／ ') || '（なし）'}`;
  return [...lines, part('使いやすかった点', good), part('使いにくかった点', bad)];
}

export function showSurvey() {
  show('survey');
  const state2 = { rating: null };
  const preview = h('ul', { class: 'plain preview', 'aria-live': 'polite' });
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const send = h('input', { type: 'checkbox', id: 'sv-send', checked: true });
  const go = h('button', { type: 'button', class: 'primary', text: '送信する', disabled: true });
  const read = () => ({ good: { picks: goodChips.picks(), text: goodText.text() }, bad: { picks: badChips.picks(), text: badText.text() } });
  const refresh = () => {
    const { good, bad } = read();
    preview.replaceChildren(...previewLines(state2.rating, send.checked, good, bad).map((t) => h('li', { text: t })));
    go.disabled = state2.rating == null;
  };
  const rating = likert({ name: 'sv-rating', legend: '全体の使いやすさ', count: 5, ends: ['使いにくい', '使いやすい'], onChange: (n) => { state2.rating = n; refresh(); } });
  const goodChips = chips('sv-good', refresh);
  const goodText = freeText('sv-good-text', refresh);
  const badChips = chips('sv-bad', refresh);
  const badText = freeText('sv-bad-text', refresh);
  send.addEventListener('change', refresh);
  go.addEventListener('click', async () => {
    go.disabled = true;
    err.hidden = true;
    try {
      await api('/api/feedback', { method: 'POST', body: { rating: state2.rating, sendToDev: send.checked, ...read() } });
      nav.showQuota('quota_plan');
    } catch (e) { err.textContent = `送信できませんでした: ${e.message}`; err.hidden = false; go.disabled = false; }
  });
  $('survey-body').replaceChildren(
    h('p', { class: 'lead', text: '無料の面接はここまでです。次のご案内の前に、感想を教えてください（2分ほど）。' }),
    h('section', { class: 'card' }, rating.el),
    h('section', { class: 'card', 'aria-labelledby': 'h-sv-good' }, h('h3', { id: 'h-sv-good', text: '使いやすかった点（任意）' }), goodChips.el, h('label', { class: 'visually-hidden', for: 'sv-good-text', text: '使いやすかった点の自由記入' }), goodText.el),
    h('section', { class: 'card', 'aria-labelledby': 'h-sv-bad' }, h('h3', { id: 'h-sv-bad', text: '使いにくかった点（任意）' }), badChips.el, h('label', { class: 'visually-hidden', for: 'sv-bad-text', text: '使いにくかった点の自由記入' }), badText.el),
    h('section', { class: 'card send-card', 'aria-labelledby': 'h-sv-send' },
      h('h3', { id: 'h-sv-send', text: '開発者に送る内容' }),
      h('label', { class: 'check-row', for: 'sv-send' }, send, h('span', { text: '使いにくかった点を開発者に送る' })),
      preview,
      h('p', { class: 'small', text: '面接の逐語録・ES・点数は送りません。この端末のデータ置き場に、上の内容だけを保存します。' })),
    err,
    h('div', { class: 'actions' }, go));
  refresh();
}
