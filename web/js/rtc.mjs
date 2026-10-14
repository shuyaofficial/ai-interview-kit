// 面接の音声: マイク・音量メーター・面接官の声の大きさ・WebRTC の後始末。
import { $ } from './dom.mjs';
import { state } from './state.mjs';
import { updateIvAvatar, destroyIvAvatar } from './iv-avatar.mjs';

export function paintMeter(level) {
  const segs = $('mic-level').children;
  const lit = Math.round(Math.min(1, level) * segs.length);
  for (let i = 0; i < segs.length; i += 1) segs[i].classList.toggle('on', i < lit);
}

export function setMicState(micState) {
  const labels = { idle: '待機中', connecting: '接続中', listening: '聞いています', speaking: '話しています' };
  if ($('mic').dataset.state === micState) return;
  $('mic').dataset.state = micState;
  $('mic-state').textContent = labels[micState];
}

const rms = (analyser, data) => {
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length);
};

function makeAnalyser(ctx, stream) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return { analyser, data: new Uint8Array(analyser.fftSize) };
}

export function startMeters(mic) {
  const rtc = state.rtc;
  rtc.audioCtx = new AudioContext();
  rtc.micTap = makeAnalyser(rtc.audioCtx, mic);
  let lastLit = -1;
  let speakingUntil = 0;
  const tick = (now) => {
    const micLevel = Math.min(1, rms(rtc.micTap.analyser, rtc.micTap.data) * 3);
    if (Math.round(micLevel * 8) !== lastLit) { lastLit = Math.round(micLevel * 8); paintMeter(micLevel); }
    if (micLevel > 0.12) speakingUntil = now + 400;
    if (!rtc.connected) setMicState('connecting');
    else setMicState(now < speakingUntil ? 'speaking' : 'listening');
    if (rtc.remoteTap) {
      const voice = Math.min(1, rms(rtc.remoteTap.analyser, rtc.remoteTap.data) * 4);
      rtc.voice = rtc.voice * 0.7 + voice * 0.3; // 静かに追従させる
    }
    updateIvAvatar({ connected: rtc.connected, voice: rtc.voice, micSpeaking: now < speakingUntil }, now);
    rtc.raf = requestAnimationFrame(tick);
  };
  rtc.voice = 0;
  rtc.raf = requestAnimationFrame(tick);
}

/** 面接官の声（remote audio）の大きさを取り、アバターの口と状態に使う。 */
export function startRemoteTap(stream) {
  state.rtc.remoteCtx = new AudioContext();
  state.rtc.remoteTap = makeAnalyser(state.rtc.remoteCtx, stream);
}

export function teardownRtc() {
  destroyIvAvatar();
  const rtc = state.rtc;
  if (!rtc) return;
  cancelAnimationFrame(rtc.raf);
  clearInterval(state.timers.elapsed);
  rtc.events?.close();
  rtc.pc?.close();
  rtc.gemini?.close();
  rtc.capture?.close();
  rtc.player?.close();
  rtc.mic?.getTracks().forEach((t) => t.stop());
  rtc.audioCtx?.close();
  rtc.remoteCtx?.close();
  state.rtc = null;
}
