// ホーム: 机の上の 4 つの入口と、机の下の行の 3 つの道具（lens・warmup・gym）、ESなしですぐ面接の帯。名前は labels.mjs。
import { $, clip } from './dom.mjs';
import { api, state, nav, clearTimers, show } from './state.mjs';
import { rankFromScores } from '../rank.mjs';
import { LABELS } from './labels.mjs';

export async function showHome() {
  clearTimers();
  nav.teardownRtc();
  show('home');
  let list = [];
  try { list = (await api('/api/sessions')).filter((x) => !(x.gym && x.status === 'ready')); } catch { /* 一覧が取れなくても入口は使える */ }
  const done = list.filter((x) => x.status === 'done' && x.scores && !x.gym);
  state.home = { ready: list.find((x) => !x.gym && (x.status === 'ready' || x.status === 'reviewing')) ?? null, latestDone: done[0] ?? null };
  const { home } = state;
  $('home-interview-desc').textContent = home.ready ? `「${clip(home.ready.company, 14)}」の準備ができています` : 'ES を添削したあと、AI の面接官と声で話します';
  const top = home.latestDone ? rankFromScores(home.latestDone.scores) : null;
  $('home-history-desc').textContent = list.length ? `${list.length} 件の記録${top ? `。直近のランクは ${top.rank}` : ''}` : '点数と、前回との差を見ます';
  $('home-practice-desc').textContent = LABELS.warmup.homeDesc;
  try {
    const w = (await api('/api/warmup')).plan;
    if (w) $('home-practice-desc').textContent = practiceLine(w);
  } catch { /* 取れなければ既定の文のまま */ }
}

const practiceLine = (w) => {
  const cur = w.sessions.find((s) => s.n === w.current);
  if (!cur) return '計画の練習は、すべて記録済みです';
  const label = w.daysToReal > 7 ? `${cur.n}回目` : `${cur.n}日目`;
  return `${label}: ${clip(cur.steps.map((x) => x.title).join(' + '), 20)}${cur.status === 'late' ? '（遅れ）' : ''}`;
};

export function setupHome() {
  $('home-es').addEventListener('click', nav.newInterview);
  $('home-interview').addEventListener('click', () => (state.home.ready ? nav.openSession(state.home.ready.id) : nav.newInterview()));
  $('home-history').addEventListener('click', nav.showHistory);
  $('home-quick').addEventListener('click', () => nav.showQuick());
  $('home-practice').addEventListener('click', () => nav.showWarmup());
  $('home-lens').addEventListener('click', () => nav.showLens());
  $('home-warmup').addEventListener('click', () => nav.showWarmup());
  $('home-gym').addEventListener('click', () => nav.showGym());
  // 机の写真が読めないとき（ファイル無し・未配信）は、4 つの入口を縦に並べる表示に切り替える
  const img = document.querySelector('.desk-img');
  const fallback = () => $('home-desk').classList.add('no-photo');
  img.addEventListener('error', fallback);
  if (img.complete && img.naturalWidth === 0) fallback();
}
