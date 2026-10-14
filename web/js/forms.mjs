// 数段階の選択（横に並ぶ丸）と、二度押しで実行するボタン。本人入力は textContent だけで描く。
import { h } from './dom.mjs';

/**
 * @param {{name: string, legend: string, count: number, ends?: [string, string], value?: number|null, onChange?: (n: number) => void}} o
 * @returns {{el: HTMLElement, value: () => number|null}}
 */
export function likert({ name, legend, count, ends = null, value = null, onChange = () => {} }) {
  const inputs = [];
  const dots = Array.from({ length: count }, (_, i) => {
    const input = h('input', { type: 'radio', name, value: String(i + 1), 'aria-label': `${legend} ${i + 1}`, checked: value === i + 1 });
    input.addEventListener('change', () => onChange(i + 1));
    inputs.push(input);
    return h('label', { class: 'dot-opt' }, input, h('span', { text: String(i + 1) }));
  });
  const el = h('fieldset', { class: 'likert' },
    h('legend', { text: legend }),
    h('div', { class: 'likert-scale' }, dots),
    ends ? h('div', { class: 'likert-ends' }, h('span', { text: ends[0] }), h('span', { text: ends[1] })) : null);
  return { el, value: () => { const on = inputs.find((i) => i.checked); return on ? Number(on.value) : null; } };
}

/** 押すと文言が変わり、4 秒以内にもう一度押したときだけ action を実行する（消す・作り直す用）。 */
export function twiceButton({ label, again, action, className = '' }) {
  const b = h('button', { type: 'button', class: className, text: label });
  let timer = null;
  b.addEventListener('click', () => {
    if (!timer) {
      b.textContent = again;
      timer = setTimeout(() => { timer = null; b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    b.textContent = label;
    action();
  });
  return b;
}

export const percent = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
