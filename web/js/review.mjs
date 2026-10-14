// ES 添削画面: 設問ごとのカードを、できた順に描く。待っている間は細い進み具合のバーを出し、失敗した設問だけ「やり直す」を出す。
import { $, h } from './dom.mjs';
import { api, state, fetchSession, watchSession } from './state.mjs';
import { progressBar, paintBars, pieceProgress, remainingSec, remainingText, startTicker } from './progress.mjs';

const SCORE_LABEL = { prep: '結論先出し', specificity: '具体性', length: '字数' };
const OPEN = ['running', 'pending', 'queued'];
let cards = new Map(); // piece -> { el, sig }

/** { id, kind, title, status, ... } の一覧（本文が空で添削しない設問は除く）。 */
function pieces(s) {
  const items = s.es.items.filter((it) => s.review.items[it.id]?.status !== 'skipped')
    .map((it) => ({ id: it.id, kind: 'es-item', title: it.title, ...s.review.items[it.id] }));
  return [...items, { id: 'plan', kind: 'es-plan', title: '面接で深掘りされそうな論点', ...s.review.plan }];
}

const expectedOf = (s, kind) => s.expected.sec[kind];

function waitingBlock(p) {
  return h('div', { class: 'wait-row' },
    h('span', { class: 'small', text: p.status === 'running' ? '添削中です' : '順番を待っています' }),
    progressBar(p.id, `${p.title}の添削の進み具合`));
}

function errorBlock(p) {
  const retry = h('button', { type: 'button', class: 'retry', text: 'やり直す' });
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      await api(`/api/sessions/${state.sessionId}/review/${p.id}/retry`, { method: 'POST', body: {} });
    } catch (e) {
      retry.disabled = false;
      $('review-state').textContent = `やり直せませんでした: ${e.message}`;
      return;
    }
    refresh();
  });
  return h('div', { class: 'wait-row' }, h('p', { class: 'error', text: `添削に失敗しました。${p.error ? `（${p.error}）` : ''}` }), retry);
}

function itemCard(p, result) {
  const body = [];
  if (OPEN.includes(p.status)) body.push(waitingBlock(p));
  else if (p.status === 'error') body.push(errorBlock(p));
  else if (result) {
    body.push(
      h('div', { class: 'scores' }, Object.entries(SCORE_LABEL).map(([k, label]) => h('span', {}, `${label} `, h('b', { text: `${result.scores[k]}` }), ' / 5'))),
      result.comments.map((c) => h('div', { class: 'comment' },
        h('blockquote', {}, h('mark', { class: 'quote', text: c.quote })),
        h('div', { class: 'bubble' },
          h('p', {}, h('span', { class: 'label', text: '問題' }), c.issue),
          h('p', {}, h('span', { class: 'label', text: '提案' }), c.suggestion)))),
      h('div', { class: 'rewrite-panel' }, h('span', { class: 'sticker', text: '書き直し例' }), h('div', { class: 'rewrite', text: result.rewrite })));
  }
  return h('article', { class: 'card review-item', 'data-piece': p.id, 'data-status': p.status },
    h('div', { class: 'review-head' }, h('h3', { text: p.title })), body);
}

function planCard(p, plan) {
  const body = [];
  if (OPEN.includes(p.status)) body.push(waitingBlock(p));
  else if (p.status === 'error') body.push(errorBlock(p));
  else if (plan) {
    body.push(plan.focusPoints.map((f) => h('div', { class: 'comment' },
      h('h4', { text: f.topic }),
      h('p', { class: 'muted', text: f.why }),
      h('ul', { class: 'plain' }, f.probes.map((q) => h('li', { text: q }))))));
  }
  return h('section', { class: 'card focus', 'data-piece': 'plan', 'data-status': p.status }, h('h3', { text: p.title }), body);
}

/** 画面を描き直す。状態が変わったカードだけ差し替える（読んでいる途中の画面を動かさない）。 */
export function paintReview(s) {
  const body = $('review-body');
  for (const p of pieces(s)) {
    const sig = `${p.status}|${p.error ?? ''}`;
    const prev = cards.get(p.id);
    if (prev?.sig === sig) continue;
    const el = p.id === 'plan' ? planCard(p, s.esReview?.plan) : itemCard(p, s.esReview?.items.find((it) => it.id === p.id));
    if (prev) prev.el.replaceWith(el);
    else body.append(el);
    cards.set(p.id, { el, sig });
  }
  paintProgress(s);
}

function summaryText(s) {
  const ps = pieces(s);
  const done = ps.filter((p) => p.status === 'done').length;
  const failed = ps.filter((p) => p.status === 'error').length;
  const left = remainingSec(ps, s.fetchedAt, (p) => expectedOf(s, p.kind));
  if (!ps.some((p) => OPEN.includes(p.status))) {
    return failed ? `${ps.length}件中${done}件完了。失敗した${failed}件は「やり直す」で再開できます。面接はそのまま始められます` : '添削が完了しました';
  }
  return `${ps.length}件中${done}件完了${left ? `・${remainingText(left)}` : ''}。待たずに面接を始めることもできます`;
}

function paintProgress(s) {
  $('review-state').textContent = summaryText(s);
  const byId = Object.fromEntries(pieces(s).map((p) => [p.id, p]));
  paintBars($('review-body'), (key) => {
    const p = byId[key];
    return p ? pieceProgress(p, s.fetchedAt, expectedOf(s, p.kind), s.expected.chars[p.kind]) : 0;
  });
}

async function refresh() {
  const id = state.sessionId;
  try {
    const s = await fetchSession(id);
    if (id !== state.sessionId || s.status === 'done' || s.status === 'scoring') return;
    paintReview(s);
  } catch (e) {
    $('review-state').textContent = e.message;
  }
}

/** 添削画面を開く。できた設問から即座に描き、残りはバーで待つ。 */
export async function openReview(s) {
  cards = new Map();
  $('review-body').replaceChildren();
  $('btn-to-interview').disabled = s.status === 'interviewing';
  state.session = s;
  paintReview(s);
  watchSession(s.id, (ev) => { if (ev.type === 'review') refresh(); });
  startTicker(state.timers, () => { if (state.session) paintProgress(state.session); });
  state.timers.review = setInterval(refresh, 4000); // SSE が切れても追いつく保険
}
