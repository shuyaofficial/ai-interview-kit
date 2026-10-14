// lens: 10問 → 5つの連続バー、逐語録の観察、最初に試す仮説。本人がバーも仮説も上書きできる。
import { $, h, meterBar, fmtDate } from './dom.mjs';
import { api, nav, show, clearTimers } from './state.mjs';
import { likert, twiceButton, percent } from './forms.mjs';
import { LABELS } from './labels.mjs';

const num = (n) => Number(n).toFixed(1);

function questionnaire(view, repaint) {
  const rows = view.items.map((it, i) => likert({
    name: `lens-${i}`, legend: `${i + 1}. 自分は、${it.text}`, count: 7, ends: [view.scale[0], view.scale[6]], value: view.answers?.[i] ?? null,
  }));
  const save = h('button', { type: 'button', class: 'primary', text: view.answers ? 'バーを更新する' : 'バーを出す', disabled: true });
  const sync = () => { save.disabled = rows.some((r) => r.value() == null); };
  rows.forEach((r) => r.el.addEventListener('change', sync));
  sync();
  save.addEventListener('click', async () => {
    save.disabled = true;
    repaint(await api('/api/lens', { method: 'POST', body: { answers: rows.map((r) => r.value()) } }));
  });
  return h('section', { class: 'card', 'aria-labelledby': 'h-lens-q' },
    h('h3', { id: 'h-lens-q', text: '10 問に答える（1〜2 分）' }),
    h('p', { class: 'small', text: `出典: ${view.source}の10項目。1 はまったく違う、7 は強くそう思う。` }),
    rows.map((r) => r.el),
    h('div', { class: 'actions' }, save));
}

function barRow(view, f, repaint) {
  const v = view.values[f.id];
  const own = view.override.bars[f.id] != null;
  const slider = h('input', { type: 'range', min: 1, max: 7, step: 0.5, value: String(v), 'aria-label': `${f.label}のバーを自分で変える` });
  slider.addEventListener('change', async () => repaint(await api('/api/lens/override', { method: 'POST', body: { bars: { [f.id]: Number(slider.value) } } })));
  const reset = own ? h('button', { type: 'button', class: 'tab', text: '質問票の値に戻す' }) : null;
  reset?.addEventListener('click', async () => repaint(await api('/api/lens/override', { method: 'POST', body: { bars: { [f.id]: null } } })));
  return h('div', { class: 'lens-row', 'data-factor': f.id },
    h('div', { class: 'lens-head' }, h('b', { text: f.label }), h('span', { class: 'lens-val', text: `${num(v)} / 7${own ? '（自分で変更）' : ''}` })),
    h('p', { class: 'small', text: f.hint }),
    meterBar('bar', ((v - 1) / 6) * 100),
    h('div', { class: 'lens-ends' }, h('span', { text: f.low }), h('span', { text: f.high })),
    slider,
    own ? h('p', { class: 'small', text: `10 問から出た値は ${num(view.scores[f.id])} です。` }) : null,
    reset);
}

function reasonText(hy) {
  if (hy.chosen) return '自分で選んだ仮説です。';
  if (hy.basis === 'transcript') return `${hy.evidence}。この点を先に試す、という設計上の仮説です。`;
  if (hy.basis === 'questionnaire') return `${hy.evidence}。この傾向がある人は、この点を先に試すと伸びやすい人が多い、という研究があります（小さな差）。`;
  return hy.evidence;
}

function hypothesisPanel(view, repaint) {
  const hy = view.hypothesis;
  const pick = h('select', { 'aria-label': '最初に試す仮説を自分で選ぶ' },
    h('option', { value: '', text: '自動（観察と10問から決める）' }),
    view.hypotheses.map((x) => h('option', { value: x.id, text: x.title, selected: view.override.hypothesis === x.id })));
  pick.addEventListener('change', async () => repaint(await api('/api/lens/override', { method: 'POST', body: { hypothesis: pick.value || null } })));
  return h('section', { class: 'panel hypothesis', 'aria-labelledby': 'h-lens-h' },
    h('h3', { id: 'h-lens-h', text: '最初に試す仮説' }),
    hy ? [
      h('span', { class: 'sticker', text: '仮説' }),
      h('h4', { text: hy.title }),
      h('p', { text: hy.tryThis }),
      h('p', { class: 'small', text: reasonText(hy) }),
      h('p', { class: 'small', text: hy.effectNote }),
    ] : h('p', { text: '10 問に答えるか、面接を1本終えると、ここに仮説が出ます。' }),
    h('div', { class: 'field-row' }, h('label', { for: 'lens-pick', text: '違うと感じたら、自分で選べます' }), Object.assign(pick, { id: 'lens-pick' })));
}

function observations(view) {
  const o = view.observations;
  const rows = o.sessions.map((s) => h('tr', {},
    h('td', { text: `${fmtDate(s.createdAt)} ${s.company}` }), h('td', { text: String(s.answers) }), h('td', { text: String(s.avgChars) }),
    h('td', { text: percent(s.numberShare) }), h('td', { text: percent(s.exampleShare) }), h('td', { text: percent(s.conclusionFirstShare) })));
  return h('section', { class: 'panel', 'aria-labelledby': 'h-lens-o' },
    h('h3', { id: 'h-lens-o', text: '逐語録の観察（直近の面接）' }),
    o.sessions.length ? [
      h('div', { class: 'obs-wrap' }, h('table', { class: 'obs-table' },
        h('thead', {}, h('tr', {}, ['面接', '回答数', '平均字数', '数字あり', '場面の合図', '結論が先頭'].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows),
        h('tfoot', {}, h('tr', {}, h('td', { text: 'まとめ' }), h('td', { text: String(o.answers) }), h('td', { text: String(o.avgChars) }),
          h('td', { text: percent(o.numberShare) }), h('td', { text: percent(o.exampleShare) }), h('td', { text: percent(o.conclusionFirstShare) }))))),
      h('p', { class: 'small', text: '文字列から数えた目安です（数字の有無、「例えば」などの合図、最初の1文の結論の合図）。意味を読んだ判定ではありません。1分の話す量の目安は約300字です。' }),
      o.answers < view.minAnswers ? h('p', { class: 'small', text: `回答が ${view.minAnswers} 件に満たないので、仮説には使っていません。` }) : null,
    ] : h('p', { class: 'muted', text: 'まだ面接の記録がありません。1本終えると、ここに回答の長さ・数字・場面・結論の位置が並びます。' }));
}

function paint(view) {
  const body = $('lens-body');
  const repaint = (v) => paint(v);
  const bars = view.values && h('section', { class: 'panel', 'aria-labelledby': 'h-lens-b' },
    h('h3', { id: 'h-lens-b', text: '5 つのバー（診断ではありません）' }),
    view.factors.map((f) => barRow(view, f, repaint)));
  const clear = twiceButton({ label: LABELS.lens.clearData, again: 'もう一度押すと消します', action: async () => repaint(await api('/api/lens/clear', { method: 'POST', body: {} })) });
  body.replaceChildren(...[
    h('p', { class: 'lead', text: '性格の「タイプ」は出しません。10 問を 5 つの連続したバーにして、最初に試すことを1つだけ出します。' }),
    hypothesisPanel(view, repaint),
    bars,
    observations(view),
    questionnaire(view, repaint),
    h('section', { class: 'panel' }, h('h3', { text: '見方' }), h('ul', { class: 'plain' }, view.notes.map((n) => h('li', { text: n }))), h('div', { class: 'actions' }, clear)),
  ].filter(Boolean));
}

export async function showLens() {
  clearTimers();
  nav.teardownRtc();
  show('lens');
  paint(await api('/api/lens'));
}
