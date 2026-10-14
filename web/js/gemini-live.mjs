// ブラウザから Gemini Live へ直接つなぐ WebSocket の薄いクライアント（DOM に触れない。偽 WebSocket でテストする）。
// url はサーバーが発行した短期トークン付きの接続先。setup（面接官プロンプト・モデル・VAD）はトークン側で固定されているので、
// ここから送る setup はモデル名と sessionResumption だけ。キー本体はブラウザに無い。
// 確認した URL: https://ai.google.dev/gemini-api/docs/ephemeral-tokens ／ https://ai.google.dev/gemini-api/docs/live-api/session-management
//   （接続は約10分で切れるので、sessionResumptionUpdate の handle を覚えておき、切れたら同じトークンでつなぎ直す。つなぎ直しは使用回数に数えない）
// 受け取るもの: serverContent.inputTranscription / outputTranscription（字幕）、modelTurn の inlineData（24kHz PCM16 の音声）、
//   interrupted / generationComplete / turnComplete、setupComplete、sessionResumptionUpdate、goAway。
// 字幕は sink.onTranscript({ role: 'user' | 'assistant', kind: 'delta' | 'done', text }) に直す（Codex の transcript/delta・done と同じ形）。
//   応募者の発話は、面接官が話し始めた時点（または一区切りの通知）で done、面接官の発話は generationComplete / turnComplete / interrupted で done。

const SETUP_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 400;

const scrub = (text) => String(text ?? '').replace(/access_token=[^&\s"']+/gi, 'access_token=[伏せ字]').replace(/auth_tokens\/[\w=+/-]+/g, '[伏せ字]').slice(0, 160);

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * @param {{url: string, model: string, kickoffText: string, sink: object, WebSocketImpl?: Function, maxReconnects?: number, setTimer?: Function}} o
 * sink: { onReady(), onState(connected), onAudio(Uint8Array), onInterrupted(), onTranscript(ev), onClosed(message) }
 */
export function createGeminiLive({ url, model, kickoffText, sink, WebSocketImpl = globalThis.WebSocket, maxReconnects = 3, setTimer = setTimeout /* つなぎ直しの待ち */ }) {
  let ws = null;
  let handle = null; // 直近の再開用 handle
  let ready = false;
  let everReady = false;
  let closing = false;
  let retries = 0;
  let cand = ''; // 応募者の未確定の発話
  let agent = ''; // 面接官の未確定の発話
  let modelActive = false;
  let settle = null;

  const send = (obj) => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); };
  const emit = (role, kind, text) => sink.onTranscript?.({ role, kind, text });

  function flushCandidate() {
    if (!cand) return;
    emit('user', 'done', cand);
    cand = '';
  }
  function startModel() {
    if (modelActive) return;
    modelActive = true;
    flushCandidate(); // 面接官が話し始めたら、応募者の発話はそこで一区切り
  }
  function endModel() {
    flushCandidate();
    if (agent) emit('assistant', 'done', agent);
    agent = '';
    modelActive = false;
  }

  function onContent(sc) {
    const inText = sc.inputTranscription?.text;
    if (inText) {
      cand += inText;
      emit('user', 'delta', inText);
    }
    for (const p of sc.modelTurn?.parts ?? []) {
      if (!p.inlineData?.data) continue;
      startModel();
      sink.onAudio?.(b64ToBytes(p.inlineData.data));
    }
    const outText = sc.outputTranscription?.text;
    if (outText) {
      startModel();
      agent += outText;
      emit('assistant', 'delta', outText);
    }
    if (sc.interrupted) { sink.onInterrupted?.(); endModel(); }
    if (sc.generationComplete || sc.turnComplete) endModel();
  }

  function onMessage(msg) {
    if (msg.setupComplete !== undefined) {
      ready = true;
      retries = 0;
      sink.onState?.(true);
      if (!everReady) {
        everReady = true;
        settle?.resolve();
        sink.onReady?.();
        send({ clientContent: { turns: [{ role: 'user', parts: [{ text: kickoffText }] }], turnComplete: true } });
      }
    }
    if (msg.sessionResumptionUpdate?.newHandle && msg.sessionResumptionUpdate.resumable !== false) handle = msg.sessionResumptionUpdate.newHandle;
    if (msg.serverContent) onContent(msg.serverContent);
  }

  function open() {
    ws = new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => send({ setup: { model: `models/${model}`, sessionResumption: handle ? { handle } : {} } });
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
      onMessage(msg);
    };
    ws.onerror = () => {}; // 詳細は取れない。close のコードと理由で扱う
    ws.onclose = (ev) => {
      const was = ready;
      ready = false;
      if (closing) return;
      if (was) sink.onState?.(false);
      if (everReady && handle && retries < maxReconnects) { // 約10分で切れる接続を、handle を付けてつなぎ直す
        retries += 1;
        setTimer(() => { if (!closing) open(); }, RECONNECT_DELAY_MS * retries);
        return;
      }
      const why = `Gemini との接続が切れた（コード ${ev.code}${ev.reason ? `、${scrub(ev.reason)}` : ''}）`;
      if (!everReady) settle?.reject(new Error(why));
      else sink.onClosed?.(why);
    };
  }

  return {
    /** つないで setupComplete を待つ。切れる・時間切れなら reject。 */
    start() {
      const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      const timer = setTimeout(() => settle.reject(new Error('Gemini の設定が受理されなかった（時間切れ）')), SETUP_TIMEOUT_MS);
      open();
      return done.finally(() => clearTimeout(timer));
    },
    /** 16kHz mono PCM16 を送る。つなぎ直しの間は捨てる。 */
    sendAudio(pcm) {
      if (!ready) return;
      send({ realtimeInput: { audio: { data: bytesToB64(new Uint8Array(pcm)), mimeType: 'audio/pcm;rate=16000' } } });
    },
    /**
     * 面接の途中で、面接官（モデル）へテキストの指示を渡す（終了の少し前に「締めてください」と伝えるときなど）。つなぎ直しの間は false。
     * 公式: Gemini 3.8 Live は clientContent を会話の途中でも使える（role は user / model）。turnComplete:true は生成中の発話を中断して、この指示に答えさせる。
     *   https://ai.google.dev/gemini-api/docs/live-api/capabilities （Model comparison の Client content と Incremental content updates）
     */
    sendText(text) {
      if (!ready) return false;
      send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
      return true;
    },
    close() {
      closing = true;
      try { ws?.close(1000); } catch { /* 既に閉じている */ }
    },
    isReady: () => ready,
  };
}
