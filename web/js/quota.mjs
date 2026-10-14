// 無料枠の画面: 次の面接を始める前の関門、無料の1回が終わったときのカード、プラン（準備中）の画面。上限の判定はサーバーが強制する（ここは案内だけ）。
import { $, h } from './dom.mjs';
import { api, state, nav, show, clearTimers } from './state.mjs';
import { showSurvey } from './survey.mjs';

export const QUOTA_CODES = { survey: 'quota_survey', plan: 'quota_plan' };

/** 面接を始められるなら true。上限なら、アンケートかプランの画面へ送って false。取れなければサーバーの判定に任せて true。 */
export async function guardQuota() {
  let q;
  try { q = await api('/api/quota'); } catch { return true; }
  if (q.next === 'ok') return true;
  nav.showQuota(q.next === 'survey' ? QUOTA_CODES.survey : QUOTA_CODES.plan);
  return false;
}

/** サーバーが返したコード（または guardQuota の判定）で、アンケートかプランの画面を開く。 */
export async function showQuota(code) {
  clearTimers();
  nav.teardownRtc();
  if (code === QUOTA_CODES.plan) await showPlans();
  else showSurvey();
}

export async function showPlans() {
  show('plans');
  let q = null;
  try { q = await api('/api/quota'); } catch { /* 取れなくても案内は出せる */ }
  const plans = state.config.plans.map((p) => h('li', { class: 'plan-row' },
    h('span', { class: 'plan-name', text: p.label }),
    h('span', { class: 'plan-price', text: p.price }),
    h('span', { class: 'pill', text: '準備中' })));
  const back = h('button', { type: 'button', class: 'primary', text: 'ホームへ戻る' });
  back.addEventListener('click', () => nav.showHome());
  $('plans-body').replaceChildren(
    h('p', { class: 'lead', text: q?.surveyDone ? 'アンケートへのご協力ありがとうございました。無料の面接は終わりました。' : '無料の面接は終わりました。' }),
    h('section', { class: 'card', 'aria-labelledby': 'h-plan-list' },
      h('h3', { id: 'h-plan-list', text: 'プラン' }),
      h('ul', { class: 'plan-list' }, plans),
      h('p', { class: 'small', text: 'プランは準備中です。金額は想定で、変わることがあります。まだ申し込みも支払いもできません。' })),
    h('div', { class: 'actions' }, back));
}

let shownFor = null;

/** 結果画面の「無料の1回が終わりました」カード。アンケートが未回答のときだけ出す。 */
export async function paintFreeEnd(sessionId) {
  const box = $('report-quota');
  if (shownFor === sessionId) return;
  shownFor = sessionId;
  box.replaceChildren();
  let q;
  try { q = await api('/api/quota'); } catch { return; }
  if (!q.enabled || !q.exhausted || q.surveyDone) return;
  const go = h('button', { type: 'button', class: 'primary', text: 'アンケートに答える（2分）' });
  go.addEventListener('click', () => showSurvey());
  box.replaceChildren(h('section', { class: 'panel free-end', role: 'region', 'aria-labelledby': 'h-free-end' },
    h('h3', { id: 'h-free-end', text: '無料の1回が終わりました' }),
    h('p', { text: '2分のアンケートにご協力ください。答えると、次のご案内（プラン）が見られます。' }),
    h('div', { class: 'actions' }, go)));
}

export const resetFreeEnd = () => { shownFor = null; $('report-quota').replaceChildren(); };
