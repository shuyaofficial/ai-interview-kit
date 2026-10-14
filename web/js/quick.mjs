// ESなしですぐ面接: 任意の会社名・業界・職種と、面接の種類だけを入れて、ES 添削を飛ばして面接画面へ進む。
import { $, h } from './dom.mjs';
import { api, state, nav, show, clearTimers } from './state.mjs';
import { LABELS } from './labels.mjs';
import { voiceChoice } from './voice-choice.mjs';

const form = { mode: 'first' };

const field = (id, text, ph) => h('label', { class: 'field', for: id }, text, h('input', { id, type: 'text', maxlength: '100', placeholder: ph, autocomplete: 'off' }));

function modeChoices() {
  return state.config.modes.map((m) => {
    const input = h('input', { type: 'radio', name: 'quick-mode', value: m.id, checked: m.id === form.mode, disabled: !m.available });
    input.addEventListener('change', () => { form.mode = m.id; $('quick-purpose').textContent = m.purposeNoEs; });
    return h('label', { class: `choice${m.available ? '' : ' off'}` }, input,
      h('span', { class: 'choice-body' }, h('b', { text: m.label }), h('span', { class: 'small', text: m.available ? `約${m.durationMin}分` : '準備中' })));
  });
}

export function showQuick() {
  clearTimers();
  nav.teardownRtc();
  show('quick');
  form.mode = 'first';
  const voice = voiceChoice('quick-voice');
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const go = h('button', { type: 'button', class: 'primary', id: 'btn-quick-start', text: '面接へ進む' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    err.hidden = true;
    try {
      const es = { noEs: true, company: $('q-company').value, industry: $('q-industry').value, role: $('q-role').value, mode: form.mode, plan: state.config.defaultPlan };
      const { id } = await api('/api/sessions', { method: 'POST', body: { es, voice: voice.value() } });
      nav.openSession(id);
    } catch (e) { err.textContent = `始められませんでした: ${e.message}`; err.hidden = false; go.disabled = false; }
  });
  $('quick-body').replaceChildren(
    h('p', { class: 'lead', text: LABELS.quick.desc }),
    h('section', { class: 'card', 'aria-labelledby': 'h-q-target' },
      h('h3', { id: 'h-q-target', text: '応募先（どれも任意）' }),
      h('div', { class: 'row3' }, field('q-company', '企業名', '空欄でもよい'), field('q-industry', '業界', '空欄でもよい'), field('q-role', '職種', '空欄でもよい')),
      h('p', { class: 'small', text: '企業名が空のときは、面接のなかで志望先を聞かれます。' })),
    h('section', { class: 'card', 'aria-labelledby': 'h-q-mode' },
      h('h3', { id: 'h-q-mode', text: '面接の種類' }),
      h('div', { class: 'choices', role: 'radiogroup', 'aria-labelledby': 'h-q-mode' }, modeChoices()),
      h('p', { id: 'quick-purpose', class: 'small', text: state.config.modes.find((m) => m.id === form.mode)?.purposeNoEs ?? '' })),
    h('section', { class: 'card', 'aria-labelledby': 'h-q-voice' }, h('h3', { id: 'h-q-voice', text: LABELS.voice.name }), voice.el),
    h('p', { class: 'small', text: 'ES を出さないので、面接官は自己紹介と回答の中身から質問します。ES 添削はありません。' }),
    err, h('div', { class: 'actions' }, go));
}
