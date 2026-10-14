// 面接画面: 段階の表示（面接の種類ごと）・字幕・経過時間・接続と終了。面接中は点数や評価を見せない。
import { $, h, ico, fmtTime, shortLabel } from './dom.mjs';
import { api, state, nav } from './state.mjs';
import { paintMeter, setMicState, startMeters, startRemoteTap, teardownRtc } from './rtc.mjs';
import { mountIvAvatar } from './iv-avatar.mjs';
import { LABELS } from './labels.mjs';
import { connectGemini, abortGemini } from './gemini-rtc.mjs';

const CAPTIONS_SHOWN = 4;
const liveCaps = {};

/** 経過秒が、段階の目安時間（timeboxSec）を積んだどの段階に当たるか。範囲外は stages.length。 */
export function stageIndexAt(elapsedSec, stages = state.stages) {
  let end = 0;
  for (let i = 0; i < stages.length; i += 1) {
    end += stages[i].timeboxSec;
    if (elapsedSec < end) return i;
  }
  return stages.length;
}

export function buildSteps() {
  $('steps').replaceChildren(...state.stages.map((st, i) => h('li', { class: 'step', 'data-step': i },
    h('span', { class: 'dot' }, String(i + 1), ico('i-check', 'ico check')),
    h('span', { class: 'step-label', text: shortLabel(st.label) }))));
  renderSteps(0);
}

function renderSteps(elapsedSec) {
  const cur = Math.min(stageIndexAt(elapsedSec), state.stages.length - 1);
  for (const li of $('steps').children) {
    const i = Number(li.dataset.step);
    li.dataset.state = i < cur ? 'done' : i === cur ? 'current' : 'todo';
    if (i === cur) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

const setConn = (text) => { $('conn-state').textContent = text; };

function interviewError(msg) {
  const el = $('interview-error');
  el.textContent = msg;
  el.hidden = !msg;
}

export function resetInterviewUi() {
  $('captions').replaceChildren();
  $('elapsed').textContent = '00:00';
  buildSteps();
  const total = state.stages.reduce((a, s) => a + s.timeboxSec, 0);
  const min = state.config.modes.find((m) => m.id === state.mode)?.durationMin ?? Math.round(total / 60);
  const gym = state.gym;
  $('gym-bar').hidden = !gym;
  $('btn-stop').disabled = false;
  if (gym) $('gym-bar-label').textContent = `${LABELS.gym.name} ${gym.label}`;
  $('interview-note').textContent = gym
    ? '圧は練習のための設定です。マイクを使います。「開始」を押すと、面接官から話し始めます。いつでも「止める」で終えられます。'
    : `マイクを使います。「開始」を押すと、面接官から話し始めます（目安 約${min}分）。`;
  paintMeter(0);
  mountIvAvatar();
  $('btn-connect').disabled = false;
  $('btn-connect').hidden = false;
  $('btn-end').disabled = true;
  $('interview-note').hidden = false;
  setMicState('idle');
  setConn('未接続');
  interviewError('');
}

/** 字幕は最新 CAPTIONS_SHOWN 件だけ残す（全文は逐語録に残る）。 */
function trimCaptions() {
  const caps = [...$('captions').children];
  for (const el of caps.slice(0, Math.max(0, caps.length - CAPTIONS_SHOWN))) {
    for (const role of Object.keys(liveCaps)) if (liveCaps[role] === el) delete liveCaps[role];
    el.remove();
  }
}

function onCaption(ev) {
  const box = $('captions');
  let el = liveCaps[ev.role];
  if (!el) {
    const at = state.rtc?.startedAt ? fmtTime((Date.now() - state.rtc.startedAt) / 1000) : '';
    el = h('div', { class: `cap cap-${ev.role} live` },
      ev.role === 'interviewer' ? ico('i-interviewer', 'cap-icon face') : ico('i-user', 'cap-icon ico'),
      h('div', { class: 'cap-body' }, h('span', { class: 'who', text: ev.role === 'interviewer' ? '面接官（AI）' : 'あなた' }), h('span', { class: 'text' })),
      h('span', { class: 'time', text: at }));
    box.append(el);
    liveCaps[ev.role] = el;
    trimCaptions();
  }
  el.querySelector('.text').textContent = ev.text;
  if (ev.final) {
    el.classList.remove('live');
    delete liveCaps[ev.role];
  }
  box.scrollTop = box.scrollHeight;
  box.classList.toggle('clipped', box.scrollHeight > box.clientHeight + 1);
}

function startElapsed() {
  const { rtc } = state;
  rtc.startedAt = Date.now();
  clearInterval(state.timers.elapsed);
  state.timers.elapsed = setInterval(() => {
    const sec = (Date.now() - rtc.startedAt) / 1000;
    $('elapsed').textContent = fmtTime(sec);
    renderSteps(sec);
  }, 500);
}

async function connect() {
  const id = state.sessionId;
  interviewError('');
  $('btn-connect').disabled = true;
  $('interview-note').hidden = true;
  state.rtc = { connected: false };
  const { rtc } = state;
  try {
    setConn('マイク許可待ち');
    rtc.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    startMeters(rtc.mic);
    setConn('接続中');
    rtc.events = new EventSource(`/api/sessions/${id}/events`);
    rtc.events.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === 'caption') onCaption(ev);
      else if (ev.type === 'error') interviewError(`エラー: ${ev.message}`);
      else if (ev.type === 'closed') setConn('切断（終了ボタンで採点へ）');
    };
    await new Promise((resolve, reject) => {
      rtc.events.onopen = resolve;
      rtc.events.onerror = () => reject(new Error('イベント接続に失敗'));
    });
    if (state.session?.voice === 'gemini') { // 面接官の声が Gemini 3.8 Live（試験）: ブラウザが Gemini へ直接つなぐ
      await connectGemini(id, rtc, {
        setConn,
        onConnected: () => { startElapsed(); $('btn-connect').hidden = true; $('btn-end').disabled = false; },
        onClosed: (message) => { setConn('切断（終了ボタンで採点へ）'); interviewError(message); },
        onWarn: interviewError,
      });
      return;
    }
    const pc = new RTCPeerConnection();
    rtc.pc = pc;
    pc.ontrack = (e) => {
      $('remote').srcObject = e.streams[0];
      if (!rtc.remoteTap) startRemoteTap(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      const labels = { connected: '接続済み', connecting: '接続中', disconnected: '切断', failed: '接続失敗', closed: '終了' };
      setConn(labels[pc.connectionState] ?? pc.connectionState);
      rtc.connected = pc.connectionState === 'connected';
      if (pc.connectionState === 'connected' && !rtc.startedAt) {
        startElapsed();
        $('btn-connect').hidden = true;
        api(`/api/sessions/${id}/kickoff`, { method: 'POST', body: {} }).catch((e) => interviewError(`開始の合図に失敗: ${e.message}`));
      }
    };
    rtc.mic.getTracks().forEach((t) => pc.addTrack(t, rtc.mic));
    pc.createDataChannel('oai-events');
    await pc.setLocalDescription(await pc.createOffer());
    const { answer } = await api(`/api/sessions/${id}/realtime`, { method: 'POST', body: { sdp: pc.localDescription.sdp } });
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    $('btn-end').disabled = false;
  } catch (e) {
    const wasGemini = state.session?.voice === 'gemini' && !rtc.startedAt;
    teardownRtc();
    if (wasGemini && !e.code?.startsWith('quota_')) await abortGemini(id); // サーバー側の「面接中」を戻す
    if (e.code?.startsWith('quota_')) { nav.showQuota(e.code); return; } // 無料枠の上限。サーバーが断った
    interviewError(`接続できませんでした: ${e.message}`);
    setConn('未接続');
    setMicState('idle');
    $('btn-connect').disabled = false;
    $('btn-connect').hidden = false;
  }
}

async function endInterview() {
  $('btn-end').disabled = true;
  try {
    await state.rtc?.up?.flush(); // Gemini の字幕の送り残しを先に届ける
    await api(`/api/sessions/${state.sessionId}/end`, { method: 'POST', body: {} });
  } catch (e) {
    interviewError(`終了に失敗: ${e.message}`);
  }
  teardownRtc();
  nav.openSession(state.sessionId);
}

/** gym の「止める」: 確認なしですぐ終える。減点にしない。接続前なら何も始まっていないので選択画面に戻る。 */
async function stopInterview() {
  const id = state.sessionId;
  $('btn-stop').disabled = true;
  if (!state.rtc) { nav.showGym(); return; }
  try {
    await state.rtc.up?.flush();
    await api(`/api/sessions/${id}/stop`, { method: 'POST', body: {} });
  } catch (e) {
    teardownRtc();
    interviewError(`止める処理でエラー: ${e.message}`);
    nav.showGym();
    return;
  }
  teardownRtc();
  nav.openSession(id);
}

export function setupInterview() {
  $('btn-stop').addEventListener('click', stopInterview);
  const dialog = $('end-dialog');
  $('btn-end').addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'ok') endInterview();
  });
  $('btn-connect').addEventListener('click', connect);
}
