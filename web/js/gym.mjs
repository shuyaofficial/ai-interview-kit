// gym（手ごわい面接官の練習）: タイプと強さを選ぶ → 毎回の同意画面（起きること・安全・開始前の自己評価）→ 面接画面へ。同意は保存しない。
import { $, h, fmtDate } from './dom.mjs';
import { api, state, nav, show, clearTimers, stagesOfMode } from './state.mjs';
import { likert } from './forms.mjs';
import { resetInterviewUi } from './interview.mjs';
import { voiceChoice } from './voice-choice.mjs';
import { LABELS } from './labels.mjs';

const cfg = () => state.config.gym;
const sel = { type: null, level: null, es: 'last', voice: 'codex', quick: { company: '', industry: '', role: '' } };
let ctx = { history: { items: [], selfTalk: {} }, lastCompany: null };

const radio = (name, id, checked, head, ...lines) => {
  const input = h('input', { type: 'radio', name, value: id, checked });
  const label = h('label', { class: 'choice' }, input, h('span', { class: 'choice-body' }, h('b', { text: head }), lines.map((t) => h('span', { text: t }))));
  return { label, input };
};

function chooseView() {
  const types = cfg().types.map((t) => radio('gym-type', t.id, sel.type === t.id, t.label, t.summary, `鍛えるもの: ${t.trains}`));
  const levels = cfg().levels.map((l) => radio('gym-level', l.id, sel.level === l.id, l.label, l.summary));
  const next = h('button', { type: 'button', class: 'primary', text: '内容を確認する', disabled: true });
  const quick = ['company', 'industry', 'role'].map((k) => {
    const input = h('input', { type: 'text', maxlength: 100, id: `gym-q-${k}`, value: sel.quick[k], 'aria-label': { company: '企業名', industry: '業界', role: '職種' }[k], placeholder: { company: '企業名（任意）', industry: '業界（任意）', role: '職種（任意）' }[k] });
    input.addEventListener('input', () => { sel.quick[k] = input.value; sync(); });
    return input;
  });
  const quickBox = h('div', { class: 'field-row' }, quick);
  const voice = voiceChoice('gym-voice', sel.voice, (v) => { sel.voice = v; });
  const esLast = radio('gym-es', 'last', sel.es === 'last', ctx.lastCompany ? `直近の ES を使う（${ctx.lastCompany}）` : '直近の ES を使う（まだありません）');
  const esQuick = radio('gym-es', 'quick', sel.es === 'quick', 'ESなしで始める（企業名・業界・職種は任意）');
  esLast.input.disabled = !ctx.lastCompany;
  if (!ctx.lastCompany) sel.es = 'quick';
  esQuick.input.checked = sel.es === 'quick';
  function sync() {
    quickBox.hidden = sel.es !== 'quick';
    next.disabled = !(sel.type && sel.level && (sel.es === 'last' ? ctx.lastCompany : true));
  }
  const on = (items, key) => items.forEach(({ input }) => input.addEventListener('change', () => { sel[key] = input.value; sync(); }));
  on(types, 'type'); on(levels, 'level'); on([esLast, esQuick], 'es');
  next.addEventListener('click', () => paintConsent());
  sync();
  return [
    h('p', { class: 'lead', text: '面接官を手ごわい役にして、答えにくい質問に慣れる練習です。苦しくなったら、いつでも「止める」で終えられます。止めても減点にはなりません。' }),
    h('p', { class: 'small', text: '医療行為ではありません。気分が悪いときや、強い不安があるときは、やらないでください。' }),
    h('section', { class: 'card', 'aria-labelledby': 'h-gym-type' }, h('h3', { id: 'h-gym-type', text: '面接官のタイプ' }), h('div', { class: 'gym-choices', role: 'radiogroup', 'aria-labelledby': 'h-gym-type' }, types.map((t) => t.label))),
    h('section', { class: 'card', 'aria-labelledby': 'h-gym-level' }, h('h3', { id: 'h-gym-level', text: '強さ' }), h('div', { class: 'gym-choices', role: 'radiogroup', 'aria-labelledby': 'h-gym-level' }, levels.map((l) => l.label)),
      h('p', { class: 'small', text: '初めてのときは「ウォームアップ」が選ばれています。3段階の分け方は設計上の仮説で、効果の裏付けはまだありません。' })),
    h('section', { class: 'card', 'aria-labelledby': 'h-gym-es' }, h('h3', { id: 'h-gym-es', text: '面接官が見る ES' }), h('div', { class: 'gym-choices' }, esLast.label, esQuick.label), quickBox),
    h('section', { class: 'card', 'aria-labelledby': 'h-gym-voice' }, h('h3', { id: 'h-gym-voice', text: LABELS.voice.name }), voice.el),
    h('div', { class: 'actions' }, next),
    history(),
  ];
}

function history() {
  const { items, selfTalk } = ctx.history;
  if (!items.length) return null;
  const t = (g) => (g.n ? `${g.avgPoints}点（${g.n}回）` : '—');
  const typeName = (id) => cfg().types.find((x) => x.id === id)?.label ?? id;
  const levelName = (id) => cfg().levels.find((x) => x.id === id)?.label ?? id;
  return h('section', { class: 'panel', 'aria-labelledby': 'h-gym-hist' },
    h('h3', { id: 'h-gym-hist', text: 'これまでの記録' }),
    h('ul', { class: 'plain' }, items.slice(0, 6).map((x) => h('li', {},
      `${fmtDate(x.createdAt)} ${typeName(x.type)}・${levelName(x.level)}`,
      x.points != null ? ` ／ ${x.points}点` : '', x.stopped ? ' ／ 途中で止めた' : '',
      x.anxietyBefore != null ? ` ／ 不安の自己評価 ${x.anxietyBefore} → ${x.anxietyAfter ?? '—'}` : ''))),
    h('p', { class: 'small', text: `三人称ひとことを使った回 ${t(selfTalk.used)} ／ 使わなかった回 ${t(selfTalk.notUsed)}。回数が少ないうちは、差があっても偶然かもしれません。` }));
}

function consentView() {
  const type = cfg().types.find((x) => x.id === sel.type);
  const level = cfg().levels.find((x) => x.id === sel.level);
  const rows = cfg().anxietyItems.map((t, i) => likert({ name: `gym-anx-${i}`, legend: `${i + 1}. ${t}`, count: 5, ends: [cfg().anxietyScale[0], cfg().anxietyScale[4]] }));
  const agree = h('input', { type: 'checkbox', id: 'gym-agree' });
  const mine = h('input', { type: 'text', id: 'gym-reappraisal', maxlength: 200, placeholder: '例: 体が「やるぞ」と準備している' });
  const go = h('button', { type: 'button', class: 'primary', id: 'btn-gym-start', text: '同意して始める', disabled: true });
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const sync = () => { go.disabled = !(agree.checked && rows.every((r) => r.value() != null)); };
  agree.addEventListener('change', sync);
  rows.forEach((r) => r.el.addEventListener('change', sync));
  const back = h('button', { type: 'button', text: '選び直す' });
  back.addEventListener('click', () => paintChoose());
  go.addEventListener('click', async () => {
    go.disabled = true;
    err.hidden = true;
    try {
      const body = { consent: true, type: sel.type, level: sel.level, anxiety: rows.map((r) => r.value()), reappraisal: mine.value, voice: sel.voice, ...(sel.es === 'quick' ? { quick: sel.quick } : {}) };
      await startInterview(await api('/api/gym/sessions', { method: 'POST', body }));
    } catch (e) { err.textContent = `始められませんでした: ${e.message}`; err.hidden = false; go.disabled = false; }
  });
  return [
    h('section', { class: 'card consent', 'aria-labelledby': 'h-gym-consent' },
      h('h3', { id: 'h-gym-consent', text: '始める前の確認（毎回ここで同意をとります）' }),
      h('ul', {},
        h('li', { text: `面接官: ${type.label}。${type.summary}` }),
        h('li', { text: `強さ: ${level.label}。${level.tendency}` }),
        h('li', { text: `質問の傾向: 答えにくい質問を2〜3回します。${cfg().hardKinds.map((k) => k.label).join('と')}の2種類です。` }),
        h('li', { text: '言わないこと: 人格・外見・出身への攻撃、性的な内容、脅し、採用で聞いてはいけない14事項は、どのタイプ・どの強さでも言いません。' }),
        h('li', { text: '止める: 面接中は画面の上にいつも「止める」ボタンがあります。押すとすぐ終わり、減点にも記録の欠損にもなりません。' }),
        h('li', { text: '記録: 会話は文字にして、この端末の中だけに保存します。音声は保存しません。' }),
        h('li', { text: '終わったあと: 圧は練習のための設定だったことと、実際の面接で困ったときの相談先をお知らせします。' })),
      h('p', { class: 'small', text: '医療行為ではありません。気分が悪いときや、強い不安があるときは、やらないでください。' })),
    h('section', { class: 'card', 'aria-labelledby': 'h-gym-anx' }, h('h3', { id: 'h-gym-anx', text: '今の気持ち（6項目）' }),
      h('p', { class: 'small', text: '短い自己評価です。診断ではなく、終わったあとの変化を見るために使います。' }), rows.map((r) => r.el)),
    h('section', { class: 'card', 'aria-labelledby': 'h-gym-heart' }, h('h3', { id: 'h-gym-heart', text: 'ドキドキの読み替え（任意）' }),
      h('p', { text: '心拍が上がるのは、体が備えている状態です。「落ち着け」と抑えるより、「体が準備している」と言い換えるほうが合う人がいます。' }),
      h('label', { class: 'field', for: 'gym-reappraisal' }, '自分の言葉にすると', mine),
      h('p', { class: 'small', text: 'この言い換えの効果は小さく、研究では d≈0.2〜0.3 程度の差でした。面接の成績で確かめた研究ではありません。' }),
      h('p', { class: 'small', text: '質問の合間には、自分の名前で「◯◯、今は質問の意味を確かめる時間だ」と声に出したり、メモしたりしてみることもできます（強制ではありません。効果は不安定です）。' })),
    h('label', { class: 'check-row', for: 'gym-agree' }, agree, h('span', { text: '上の内容を読み、同意して始めます（同意は次回に持ち越しません）' })),
    err,
    h('div', { class: 'actions' }, back, go),
  ];
}

async function startInterview({ id }) {
  const s = await api(`/api/sessions/${id}`);
  clearTimers();
  state.sessionId = id;
  state.session = s;
  state.mode = s.mode;
  state.stages = stagesOfMode(s.mode);
  state.gym = { type: sel.type, level: sel.level, label: s.gym.typeLabel };
  resetInterviewUi();
  show('interview');
}

function paintChoose() { $('gym-body').replaceChildren(...chooseView().filter(Boolean)); window.scrollTo(0, 0); }
function paintConsent() { $('gym-body').replaceChildren(...consentView()); window.scrollTo(0, 0); }

export async function showGym(preset = {}) {
  clearTimers();
  nav.teardownRtc();
  state.gym = null;
  show('gym');
  const [history, list] = await Promise.all([api('/api/gym').catch(() => ctx.history), api('/api/sessions').catch(() => [])]);
  ctx = { history, lastCompany: list.find((x) => !x.gym && !x.noEs)?.company ?? null };
  sel.type = null;
  sel.voice = 'codex';
  sel.level = preset.level ?? cfg().defaultLevel;
  paintChoose();
}

