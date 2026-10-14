// 面接官の声が Gemini 3.8 Live（試験）のときの接続: サーバーから短期トークンをもらい、ブラウザが Gemini へ直接つなぐ。
// マイクを 16kHz PCM16 で送り、返る 24kHz の音声を再生し、字幕はサーバーへ送って Codex と同じ逐語録・字幕・採点に流す。
import { api } from './state.mjs';
import { createGeminiLive } from './gemini-live.mjs';
import { createUploader } from './voice-upload.mjs';
import { startCapture, createPlayer } from './pcm-audio.mjs';

/**
 * rtc に gemini / player / capture / up / remoteTap / connected を置く（teardownRtc が後始末する）。
 * hooks: { setConn(text), onConnected(), onClosed(message), onWarn(message) }。接続できなければ例外を投げる。
 */
export async function connectGemini(id, rtc, hooks) {
  const { url, model, kickoffText } = await api(`/api/sessions/${id}/gemini`, { method: 'POST', body: {} });
  rtc.up = createUploader({
    send: (body) => api(`/api/sessions/${id}/voice`, { method: 'POST', body }),
    onError: (e) => hooks.onWarn(`字幕をサーバーへ送れなかった: ${e.message}`),
  });
  rtc.player = await createPlayer();
  rtc.remoteTap = rtc.player.tap;
  rtc.gemini = createGeminiLive({
    url, model, kickoffText,
    sink: {
      onReady: () => { rtc.connected = true; rtc.up.markReady(); hooks.onConnected(); },
      onState: (connected) => { rtc.connected = connected; hooks.setConn(connected ? '接続済み' : '再接続中'); },
      onAudio: (bytes) => rtc.player.push(bytes),
      onInterrupted: () => rtc.player.clear(),
      onTranscript: (ev) => rtc.up.push(ev),
      onClosed: (message) => { rtc.connected = false; hooks.onClosed(message); },
    },
  });
  await rtc.gemini.start();
  rtc.capture = await startCapture(rtc.mic, (chunk) => rtc.gemini.sendAudio(chunk));
}

/** 接続前に失敗したとき、サーバー側の「面接中」を元に戻す（失敗しても無視）。 */
export const abortGemini = (id) => api(`/api/sessions/${id}/gemini/abort`, { method: 'POST', body: {} }).catch(() => {});
