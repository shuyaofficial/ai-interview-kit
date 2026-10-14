// 画面どうしで共有する状態と、API 呼び出し・画面切替。
// 画面モジュールどうしが循環 import しないよう、画面遷移の関数は app.js が nav に登録する。
import { $ } from './dom.mjs';

export const SCREENS = ['home', 'es', 'review', 'interview', 'report', 'history', 'lens', 'warmup', 'gym', 'quick', 'survey', 'plans'];

export const state = {
  config: null,
  sessionId: null,
  session: null, // 直近に取得したセッション（fetchedAt 付き）
  mode: 'first', // 今のセッションの面接の種類
  stages: [], // 今のセッションの面接の種類の段階
  watcher: null,
  timers: { review: null, report: null, elapsed: null, tick: null },
  rtc: null,
  gym: null, // gym（手ごわい面接官の練習）の面接中だけ { type, level, label }
  home: { ready: null, latestDone: null },
};

/** 画面遷移の関数（app.js が登録する）: openSession, newInterview, showHistory, showHome, showLens, showWarmup, showGym, showQuick, showQuota */
export const nav = {};

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code ?? null });
  return data;
}

/** セッションを取り、取得時刻（進み具合の補間用）を付けて state に置く。 */
export async function fetchSession(id) {
  const s = await api(`/api/sessions/${id}`);
  s.fetchedAt = performance.now();
  if (id === state.sessionId) state.session = s;
  return s;
}

export function show(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

export function clearTimers() {
  for (const k of ['review', 'report', 'tick']) {
    clearInterval(state.timers[k]);
    state.timers[k] = null;
  }
  state.watcher?.close();
  state.watcher = null;
}

/** セッションのイベント（SSE）を購読する。イベントは「再取得の合図」。切れても画面側のゆっくりした再取得で追いつく。 */
export function watchSession(id, onEvent) {
  state.watcher?.close();
  const es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* 読めないイベントは捨てる */ } };
  state.watcher = es;
  return es;
}

export function stagesOfMode(mode) {
  return state.config.modes.find((m) => m.id === mode)?.stages ?? state.config.stages;
}
