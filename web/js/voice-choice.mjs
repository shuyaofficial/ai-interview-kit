// 面接官の声の選択（いつもの / Gemini 3.8 Live（試験））。ESなし・ES あり・gym（手ごわい面接官）の3か所で同じものを使う。
// Gemini は、サーバーに GEMINI_ENV_FILE が設定されているときだけ選べる（無ければ「準備中」）。選んだときだけ注意を1行出す。
import { h } from './dom.mjs';
import { state } from './state.mjs';
import { LABELS } from './labels.mjs';

/** @returns {{el: HTMLElement, value: () => string}} el を card に入れて使う。value() は 'codex' か 'gemini'。 */
export function voiceChoice(name, initial = 'codex', onChange = () => {}) {
  let value = initial;
  const options = state.config.voices ?? [];
  const notice = h('p', { class: 'small voice-notice', role: 'status', hidden: value !== 'gemini', text: LABELS.voice.geminiNotice });
  const choices = options.map((o) => {
    const input = h('input', { type: 'radio', name, value: o.id, checked: o.id === value, disabled: !o.available });
    input.addEventListener('change', () => {
      value = o.id;
      notice.hidden = o.id !== 'gemini';
      onChange(value);
    });
    return h('label', { class: `choice${o.available ? '' : ' off'}` }, input,
      h('span', { class: 'choice-body' }, h('b', { text: o.label }), o.available ? null : h('span', { class: 'small', text: o.offText })));
  });
  return { el: h('div', {}, h('div', { class: 'choices', role: 'radiogroup', 'aria-label': LABELS.voice.name }, choices), notice), value: () => value };
}

/** レポートと履歴に小さく出す、どちらの声だったか。short は履歴の狭い欄用。古い面接（voice なし）はいつもの声。 */
export const voiceLabel = (id, short = false) => (id === 'gemini' ? (short ? LABELS.voice.geminiShort : LABELS.voice.gemini) : LABELS.voice.codexShort);
