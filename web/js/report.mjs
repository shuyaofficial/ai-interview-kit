// 結果画面: 面接中に採点が済んだ質問は即表示し、6軸と総評は「作成中」の枠で待たせて、できたら差し込む。
// 上部に全体の進み具合(%)を出す。同じ逐語録を別プランで採点し直して、タブで並べて比べられる。
import { $, h, fmtDate } from './dom.mjs';
import { api, state, fetchSession, watchSession } from './state.mjs';
import { progressBar, paintBars, pieceProgress, remainingSec, remainingText, startTicker } from './progress.mjs';
import { renderOverall, renderAxes, renderPractice, renderSpeech, renderTranscript, renderCompliance } from './report-parts.mjs';
import { renderQuestions } from './report-questions.mjs';
import { renderRecovery } from './report-recovery.mjs';
import { paintGymEnd, paintGymExtra, resetGymReport } from './gym-report.mjs';
import { paintFreeEnd, resetFreeEnd } from './quota.mjs';
import { voiceLabel } from './voice-choice.mjs';

const OPEN = ['running', 'pending', 'queued'];
let sections = null; // { meta, top, questions, bottom }: 各 { el, sig }
let prevScores = null;
let view = ''; // 表示中のプラン（'' = このセッションのプラン）

const planLabel = (id) => state.config.plans.find((p) => p.id === id)?.label ?? id;

async function previousScores(id) {
  try {
    const list = await api('/api/sessions');
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return null;
    return list.slice(i + 1).find((x) => x.status === 'done' && x.scores && Boolean(x.gym) === Boolean(list[i].gym))?.scores ?? null; // gym は、gym どうしで比べる
  } catch {
    return null;
  }
}

/** 進行中の処理の一覧（質問ごと + final）。完了した分は含めても 1 として数える。 */
function units(s) {
  const ex = (s.scoring?.exchanges ?? []).map((e) => ({ ...e, key: `ex-${e.index}`, kind: 'q-score', weight: 1 }));
  return [...ex, { ...(s.scoring?.final ?? { status: 'pending' }), key: 'final', kind: 'final', weight: 2 }];
}

function overall(s) {
  const us = units(s);
  const done = s.status === 'done';
  const total = us.reduce((a, u) => a + u.weight, 0);
  const sum = us.reduce((a, u) => a + u.weight * (done ? 1 : pieceProgress(u, s.fetchedAt, s.expected.sec[u.kind], s.expected.chars[u.kind])), 0);
  const left = remainingSec(us, s.fetchedAt, (u) => s.expected.sec[u.kind]);
  return { pct: Math.round((sum / total) * 100), left, us };
}

function shown(s) {
  if (view && s.reportAlt?.plan === view) return { report: s.reportAlt.report, partial: null, plan: view };
  return { report: s.report, partial: s.scoring?.final?.result ?? null, plan: s.plan };
}

// ---------- 各部分 ----------

function metaBlock(s, plan) {
  const box = h('div', { class: 'report-meta' }, h('p', { class: 'muted', text: `${s.es.company || '（会社名なし）'} / ${s.report ? fmtDate(s.report.createdAt) : '採点中'} / 面接官の声: ${voiceLabel(s.voice)}` }));
  if (s.status !== 'done') return box;
  const other = state.config.plans.find((p) => p.id !== s.plan);
  const tabs = s.reportAlt && h('div', { class: 'tabs plan-tabs', role: 'group', 'aria-label': '採点したプラン' },
    [s.plan, s.reportAlt.plan].map((id) => {
      const b = h('button', { type: 'button', class: 'tab', 'aria-pressed': String(plan === id), text: `${planLabel(id)}${id === s.plan ? '（このプラン）' : '（比較）'}` });
      b.addEventListener('click', () => { view = id === s.plan ? '' : id; paint(state.session); });
      return b;
    }));
  const cmp = s.compare;
  let action = null;
  if (!s.reportAlt && other) {
    if (cmp?.status === 'running') {
      action = h('div', { class: 'wait-row' }, h('span', { class: 'small', text: `${other.label}で採点中です` }), progressBar('compare', '比較の採点の進み具合'));
    } else {
      const btn = h('button', { type: 'button', class: 'compare', text: `${other.label}でも採点して比べる` });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await api(`/api/sessions/${s.id}/compare`, { method: 'POST', body: { plan: other.id } }); } catch (e) { $('report-wait').textContent = `比較を始められませんでした: ${e.message}`; }
        refresh();
      });
      action = h('div', { class: 'wait-row' }, btn, cmp?.status === 'error' ? h('span', { class: 'error', text: `前回の比較は失敗しました（${cmp.error}）` }) : null);
    }
  }
  box.append(...[h('p', { class: 'plan-note' }, h('span', { class: 'sticker', text: 'このプランで採点' }), ` ${planLabel(s.plan)}`), tabs, action].filter(Boolean));
  return box;
}

function placeholderTop(s) {
  const o = overall(s);
  return h('div', { class: 'report-top' },
    h('section', { class: 'panel pending-panel' },
      h('h3', { text: '総評と6軸のスコア' }),
      h('p', { class: 'summary', text: `総評を作成中・${remainingText(Math.max(2, Math.round(s.expected.sec.final - (s.scoring?.final?.elapsedSec ?? 0))))}` }),
      progressBar('final', '総評の作成の進み具合')));
}

function topBlock(scoring) {
  return h('div', { class: 'report-top' }, renderOverall(scoring), renderAxes(scoring, prevScores), renderPractice(scoring));
}

function questionList(s, report, plan) {
  if (report) return report.scoring.questions.map((q, i) => ({ key: `r-${i}`, status: 'done', question: q.question, result: q, startMs: q.startMs }));
  if (plan !== s.plan) return [];
  return (s.scoring?.exchanges ?? []).map((e) => ({ key: `ex-${e.index}`, status: e.status, question: e.question, result: e.result, startMs: e.result?.startMs }));
}

// ---------- 描画 ----------

function put(name, sig, build) {
  const prev = sections[name];
  if (prev?.sig === sig) return;
  const el = build();
  if (prev) prev.el.replaceWith(el);
  else $('report-body').append(el);
  sections[name] = { el, sig };
}

function paint(s) {
  if (!s) return;
  paintGymEnd(s, () => refresh());
  paintGymExtra(s);
  if (s.status === 'stopped') {
    for (const k of Object.keys(sections)) { sections[k].el.remove(); delete sections[k]; }
    paintWait(s);
    return;
  }
  const { report, partial, plan } = shown(s);
  const scoring = report?.scoring ?? partial;
  const scrolls = $('report-body').querySelector('.qtrack')?.scrollLeft ?? 0;
  const qs = questionList(s, report, plan);
  const qsig = qs.map((q) => `${q.status}${q.result?.quoteInvalid ? '!' : ''}`).join(',');
  put('meta', `${s.status}|${plan}|${s.compare?.status}|${s.reportAlt ? 1 : 0}`, () => metaBlock(s, plan));
  const failed = (s.scoring?.exchanges ?? []).filter((e) => e.status === 'error').map((e) => e.index).join(',');
  put('recovery', `${s.status}|${failed}|${s.transcript ? 1 : 0}`, () => renderRecovery(s, () => refresh()) ?? h('div'));
  put('warn', `${plan}|${scoring ? scoring.compliance?.violations?.length : '-'}|${report ? 1 : 0}`, () => renderCompliance(report?.compliance?.violations ?? []) ?? h('div'));
  put('top', `${plan}|${scoring ? 'fin' : 'wait'}`, () => (scoring ? topBlock(scoring) : placeholderTop(s)));
  put('questions', `${plan}|${qsig}`, () => renderQuestions(qs, s.transcript));
  const track = $('report-body').querySelector('.qtrack');
  if (track && scrolls) track.scrollLeft = scrolls;
  put('bottom', `${plan}|${report ? 1 : 0}`, () => (report && s.transcript ? h('div', { class: 'report-bottom' }, renderSpeech(report), renderTranscript(s.transcript)) : h('div')));
  paintWait(s);
}

function paintWait(s) {
  const wait = $('report-wait');
  const box = $('report-progress');
  if (s.status === 'stopped') {
    wait.textContent = '応募者の発言が記録されなかったため、採点はありません。止めたことは、減点にも記録の欠損にもなりません。';
    box.hidden = true;
    return;
  }
  if (s.status === 'error') {
    wait.textContent = s.error || 'エラーが発生しました';
    box.hidden = true;
    return;
  }
  if (s.status === 'done') {
    wait.textContent = '';
    box.hidden = true;
  } else {
    const o = overall(s);
    wait.textContent = `採点中 ${o.pct}%${o.left ? `・${remainingText(o.left)}` : ''}。質問ごとの結果は、できた順に下へ出ます。`;
    box.hidden = false;
    if (!box.firstChild) box.append(progressBar('overall', '採点全体の進み具合'));
  }
  const us = Object.fromEntries(units(s).map((u) => [u.key, u]));
  paintBars($('screen-report'), (key) => {
    if (key === 'overall') return overall(s).pct / 100;
    if (key === 'compare') return Math.min(0.95, ((s.compare?.elapsedSec ?? 0) + (performance.now() - s.fetchedAt) / 1000) / s.expected.sec.score);
    const u = us[key];
    return u ? pieceProgress(u, s.fetchedAt, s.expected.sec[u.kind], s.expected.chars[u.kind]) : 0;
  });
}

async function refresh() {
  const id = state.sessionId;
  try {
    const s = await fetchSession(id);
    if (id !== state.sessionId) return;
    paint(s);
    const settled = (s.status === 'stopped' || s.status === 'done') && s.compare?.status !== 'running' && (!s.gym || s.status === 'stopped' || Boolean(s.gymScore));
    if (settled) {
      clearInterval(state.timers.report);
      state.timers.report = null;
    } else if (!state.timers.report) {
      state.timers.report = setInterval(refresh, 3000);
    }
  } catch (e) {
    $('report-wait').textContent = e.message;
  }
}

/** 結果画面を開く。採点中なら、できた分から順に描く。 */
export async function openReport(s) {
  sections = {};
  view = '';
  $('report-body').replaceChildren();
  $('report-progress').replaceChildren();
  $('report-wait').textContent = '';
  resetGymReport();
  resetFreeEnd();
  paintFreeEnd(s.id);
  prevScores = await previousScores(s.id);
  state.session = s;
  paint(s);
  watchSession(s.id, (ev) => { if (['scoring', 'report', 'compare', 'gym'].includes(ev.type)) refresh(); });
  startTicker(state.timers, () => { if (state.session && (state.session.status !== 'done' || state.session.compare?.status === 'running')) paintWait(state.session); });
  state.timers.report = setInterval(refresh, 3000); // SSE が切れても追いつく保険
}
