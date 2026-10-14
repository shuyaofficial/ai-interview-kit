// warmup: 本番までの日数に合わせた練習の計画、今日のやること、実施記録、自信度の自己申告、1回目と最終回の点の差。
// 並びは研究の直接の裏付けが無い仮説。「7日で自信がつく」とは書かず、見せるのは自分の点の差だけ。
import { $, h, fmtDate } from './dom.mjs';
import { api, state, nav, show, clearTimers } from './state.mjs';
import { likert, twiceButton } from './forms.mjs';
import { LABELS } from './labels.mjs';

const md = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const label = (plan, n) => (plan.daysToReal > 7 ? `${n}回目` : `${n}日目`);
const stepNames = (s) => s.steps.map((x) => x.title).join(' + ');
let data = null;

async function repaintWith(promise) {
  data = { ...data, ...(await promise) };
  paint();
}

function createForm() {
  const days = h('input', { type: 'number', id: 'wu-days', min: data.minDays, max: data.maxDays, value: '7', inputmode: 'numeric' });
  const when = h('input', { type: 'text', id: 'wu-when', maxlength: 40, placeholder: '例: 平日の夜9時' });
  const where = h('input', { type: 'text', id: 'wu-where', maxlength: 40, placeholder: '例: 自室の机' });
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const go = h('button', { type: 'button', class: 'primary', text: '計画を作る' });
  go.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await repaintWith(api('/api/warmup', { method: 'POST', body: { daysToReal: Number(days.value), intention: { when: when.value, where: where.value } } }));
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  return h('section', { class: 'card', 'aria-labelledby': 'h-wu-new' },
    h('h3', { id: 'h-wu-new', text: '計画を作る' }),
    h('div', { class: 'field-row' }, h('label', { for: 'wu-days', text: '本番まで' }), days, h('span', { text: `日（${data.minDays}〜${data.maxDays}日）` })),
    h('p', { class: 'small', text: '7日あれば、1日に1つずつ。それより短いときは詰め、長いときは間隔を空けます。最後の練習は本番の前日です。' }),
    h('div', { class: 'field-row' }, h('label', { for: 'wu-when', text: 'いつ' }), when, h('label', { for: 'wu-where', text: 'どこで' }), where),
    h('p', { class: 'small', text: '練習する時間と場所を先に決めておくと、続けやすいと言われています。空欄でも作れます。' }),
    err, h('div', { class: 'actions' }, go));
}

function stepBlock(step, plan) {
  const act = {
    interview: () => h('button', { type: 'button', text: '面接を始める' }),
    gym: () => h('button', { type: 'button', text: `${LABELS.gym.name}へ（ウォームアップ）` }),
  }[step.action]?.();
  act?.addEventListener('click', () => (step.action === 'gym' ? nav.showGym({ level: 'warmup' }) : state.home?.ready ? nav.openSession(state.home.ready.id) : nav.newInterview()));
  const quick = step.action === 'interview' ? h('button', { type: 'button', text: LABELS.quick.name }) : null; // ES が無くても練習を始められる
  quick?.addEventListener('click', () => nav.showQuick());
  return h('div', { class: 'wu-step' }, h('b', { text: step.title }), h('p', { text: step.todo }),
    step.action === 'recall' ? h('ol', { class: 'wu-cards' }, data.cards.slice(0, 5).map((c) => h('li', { text: `${c.stage}: ${c.question}` }))) : null,
    act ? h('div', { class: 'actions' }, act, quick) : null);
}

function recordForm(cur, plan) {
  const conf = likert({ name: 'wu-conf', legend: 'この練習の前、本番への自信度は？（自己申告）', count: 5, ends: ['まったく自信がない', 'とても自信がある'], value: cur.done?.confidence ?? null });
  const latest = data.linkable.find((x) => x.createdAt.slice(0, 10) >= plan.startDate);
  const link = h('select', { id: 'wu-link', 'aria-label': 'この練習の面接を選ぶ' },
    h('option', { value: '', text: '面接は使わない（記録だけ）' }),
    data.linkable.map((x) => h('option', { value: x.id, selected: (cur.done?.sessionId ?? latest?.id) === x.id, text: `${fmtDate(x.createdAt)} ${x.company}${x.gym ? `（${LABELS.gym.short}）` : ''} ${x.points}点` })));
  const save = h('button', { type: 'button', class: 'primary', text: cur.done ? '記録を更新する' : '実施を記録する', disabled: cur.done == null });
  conf.el.addEventListener('change', () => { save.disabled = conf.value() == null; });
  save.addEventListener('click', async () => {
    save.disabled = true;
    await repaintWith(api('/api/warmup/done', { method: 'POST', body: { n: cur.n, confidence: conf.value(), sessionId: link.value || null } }));
  });
  return h('div', {}, conf.el, h('div', { class: 'field-row' }, h('label', { for: 'wu-link', text: '採点と並べる面接' }), link), h('div', { class: 'actions' }, save));
}

function todayCard(plan) {
  const cur = plan.sessions.find((s) => s.n === plan.current);
  if (!cur) return h('section', { class: 'panel wu-today' }, h('h3', { text: '今日の練習' }), h('p', { text: '計画の練習は、すべて記録済みです。下の点の差を見てください。' }));
  const when = cur.status === 'today' ? '今日' : cur.status === 'late' ? `${md(cur.date)}の予定（遅れています）` : `次は${md(cur.date)}`;
  return h('section', { class: 'panel wu-today', 'aria-labelledby': 'h-wu-today' },
    h('h3', { id: 'h-wu-today', text: '今日の練習' }),
    h('span', { class: `pill ${cur.status}`, text: `${label(plan, cur.n)} / ${when}` }),
    h('h4', { text: stepNames(cur) }),
    cur.steps.map((s) => stepBlock(s, plan)),
    recordForm(cur, plan));
}

function list(plan) {
  const items = plan.sessions.map((s) => {
    const undo = s.done ? h('button', { type: 'button', class: 'tab', text: '記録を取り消す' }) : null;
    undo?.addEventListener('click', () => repaintWith(api('/api/warmup/undo', { method: 'POST', body: { n: s.n } })));
    const status = { done: '記録済み', today: '今日', late: '遅れ', upcoming: '予定' }[s.status];
    return h('li', { class: 'wu-day', 'data-status': s.status },
      h('span', { class: 'n', text: label(plan, s.n) }), h('span', { class: 'what', text: stepNames(s) }), h('span', { class: `pill ${s.status}`, text: status }),
      h('span', { class: 'meta' }, `${md(s.date)}`,
        s.done ? ` ／ 自信度 ${s.done.confidence} / 5` : '', s.points != null ? ` ／ 採点 ${s.points}点` : '', s.done ? ' ／ ' : '', undo));
  });
  return h('ul', { class: 'wu-list' }, items);
}

function diffPanel(plan) {
  const a = label(plan, 1);
  const b = label(plan, plan.sessions.length);
  const d = plan.diff;
  return h('section', { class: 'panel', 'aria-labelledby': 'h-wu-diff' },
    h('h3', { id: 'h-wu-diff', text: `${a}と${b}の点の差` }),
    d ? [
      h('p', { class: 'wu-diff' }, `${a} `, h('b', { text: `${d.first}点` }), ` → ${b} `, h('b', { text: `${d.last}点` }), h('b', { class: d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : '', text: `（${d.delta > 0 ? '+' : ''}${d.delta}）` })),
      h('p', { class: 'small', text: 'あなた自身の記録の差です。本番の結果を約束するものではありません。' }),
    ] : h('p', { class: 'muted', text: `${a}と${b}に、採点された面接を紐づけると、ここに点の差が出ます（100点換算）。` }));
}

function planPanels(plan) {
  const reset = twiceButton({ label: '計画を作り直す', again: 'もう一度押すと、今の計画を消します', action: () => repaintWith(api('/api/warmup/clear', { method: 'POST', body: {} })) });
  return [
    h('section', { class: 'panel' }, h('h3', { text: `本番まで あと ${plan.daysLeft} 日（${md(plan.realDate)}）` }), h('p', { class: 'small', text: plan.note }),
      plan.intention.when || plan.intention.where ? h('p', { class: 'small', text: `決めたこと: ${[plan.intention.when, plan.intention.where].filter(Boolean).join('、')}` }) : null),
    todayCard(plan),
    h('section', { class: 'panel', 'aria-labelledby': 'h-wu-list' }, h('h3', { id: 'h-wu-list', text: '計画' }), list(plan)),
    diffPanel(plan),
    h('section', { class: 'panel' }, h('h3', { text: 'フィードバックの3層' }), h('ul', { class: 'plain' }, plan.layers.map((t) => h('li', { text: t })))),
    h('section', { class: 'panel' }, h('h3', { text: 'この計画について' }), h('ul', { class: 'plain' }, plan.notes.map((t) => h('li', { text: t }))), h('div', { class: 'actions' }, reset)),
  ];
}

function paint() {
  const plan = data.plan;
  $('warmup-body').replaceChildren(
    h('p', { class: 'lead', text: '間隔を空けて、見ずに思い出し、直す点を1つに絞って練習します。7つの練習を、本番までの日数に合わせて並べます。' }),
    ...(plan ? planPanels(plan) : [createForm(), h('section', { class: 'panel' }, h('h3', { text: 'この計画について' }),
      h('ul', { class: 'plain' }, ['この7つの並びは、研究の直接の裏付けが無い仮説です。「7日で自信がつく」とは言えません。', '画面に出す成果は、あなた自身の1回目と最終回の点の差だけです。'].map((t) => h('li', { text: t }))))]));
}

export async function showWarmup() {
  clearTimers();
  nav.teardownRtc();
  show('warmup');
  const [w, list] = await Promise.all([api('/api/warmup'), api('/api/sessions').catch(() => [])]);
  data = w;
  state.home = { ...state.home, ready: list.find((x) => !x.gym && (x.status === 'ready' || x.status === 'reviewing')) ?? null };
  paint();
}
