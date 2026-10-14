// DOM を作る小さな道具。本人入力と LLM 出力は textContent だけで描画する（innerHTML は使わない）。
export const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 要素を作る。children は文字列（textContent）か Node。 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** 横棒。幅は CSSOM で入れる（CSP が style 属性を許さないため）。 */
export function meterBar(cls, percent) {
  const fill = h('span');
  fill.style.width = `${percent}%`;
  return h('span', { class: cls }, fill);
}

/** 横棒の幅だけを更新する。 */
export function setBar(bar, percent) {
  const fill = bar.firstElementChild;
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

/** index.html の <symbol> を参照するアイコン。 */
export function ico(id, cls = 'ico') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export const fmtTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const fmtDate = (iso) => new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
export const shortLabel = (label) => label.split(/[・（(]/)[0];
export const axisScores = (axes) => Object.fromEntries(axes.map((a) => [a.axis, a.score]));

export function clip(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}
