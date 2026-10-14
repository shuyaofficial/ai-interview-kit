// 入口。画面ごとの処理は js/*.mjs に分けてある（1 ファイル 400 行以下）。画面遷移だけをここで結ぶ。
import { $ } from './js/dom.mjs';
import { api, state, nav, show, clearTimers, fetchSession, stagesOfMode } from './js/state.mjs';
import { setupHome, showHome } from './js/home.mjs';
import { setupEsForm, resetEsForm } from './js/es-form.mjs';
import { openReview } from './js/review.mjs';
import { setupInterview, resetInterviewUi } from './js/interview.mjs';
import { teardownRtc } from './js/rtc.mjs';
import { openReport } from './js/report.mjs';
import { showHistory } from './js/history.mjs';
import { showLens } from './js/lens.mjs';
import { showWarmup } from './js/warmup.mjs';
import { showGym } from './js/gym.mjs';
import { showQuick } from './js/quick.mjs';
import { applyLabels } from './js/labels.mjs';
import { guardQuota, showQuota, resetFreeEnd } from './js/quota.mjs';

async function openSession(id) {
  clearTimers();
  teardownRtc();
  state.sessionId = id;
  state.gym = null;
  const s = await fetchSession(id);
  state.mode = s.mode;
  state.stages = stagesOfMode(s.mode);
  if (s.gym && !s.transcript && s.status !== 'stopped') { // 始めただけの gym は、同意からやり直す
    showGym();
    return;
  }
  if (['done', 'scoring', 'stopped'].includes(s.status) || (s.status === 'error' && s.transcript)) {
    show('report');
    await openReport(s);
    return;
  }
  if (s.noEs && !s.transcript) { // ESなしは添削するものが無いので、すぐ面接画面へ
    toInterview();
    return;
  }
  show('review');
  await openReview(s);
}

function toInterview() {
  state.gym = null;
  clearTimers();
  resetInterviewUi();
  show('interview');
}

/** 次の面接を始める入口。無料枠が尽きていれば、アンケートかプランの画面へ送る。 */
const guarded = (fn) => async (...args) => { if (await guardQuota()) await fn(...args); };

function newInterview() {
  resetFreeEnd();
  clearTimers();
  teardownRtc();
  state.sessionId = null;
  resetEsForm();
  show('es');
}

async function main() {
  state.config = await api('/api/config');
  state.stages = state.config.stages;
  applyLabels();
  Object.assign(nav, { openSession, newInterview: guarded(newInterview), showHistory, showHome, teardownRtc, showLens, showWarmup, showGym: guarded(showGym), showQuick: guarded(showQuick), showQuota });
  setupEsForm();
  setupHome();
  setupInterview();
  $('nav-home').addEventListener('click', showHome);
  $('nav-new').addEventListener('click', nav.newInterview);
  $('es-to-quick').addEventListener('click', nav.showQuick);
  $('nav-history').addEventListener('click', showHistory);
  $('btn-to-interview').addEventListener('click', guarded(toInterview));
  showHome();
}

main();
