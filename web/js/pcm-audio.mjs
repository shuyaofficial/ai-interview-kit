// Gemini Live 用の音声の入出力（ブラウザ専用）。マイクは 16kHz の PCM16、再生は 24kHz の PCM16。
// AudioWorklet のコードは worklets/ の外部ファイルに置く（CSP が blob: のスクリプトを許さないため）。

/** マイクを 16kHz PCM16（50ms ごと）にして onChunk(ArrayBuffer) へ渡す。戻り値の close() で止める。 */
export async function startCapture(mic, onChunk) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/js/worklets/pcm-capture-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  node.port.onmessage = (e) => onChunk(e.data);
  const mute = ctx.createGain(); // 処理を回すために出力へつなぐが、音は出さない
  mute.gain.value = 0;
  ctx.createMediaStreamSource(mic).connect(node);
  node.connect(mute).connect(ctx.destination);
  await ctx.resume();
  return { close: () => ctx.close().catch(() => {}) };
}

/** 24kHz PCM16 を鳴らす。tap は音量を測る Analyser（面接官アバターの口と状態に使う）。 */
export async function createPlayer() {
  const ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.audioWorklet.addModule('/js/worklets/pcm-player-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  analyser.connect(ctx.destination);
  await ctx.resume();
  return {
    tap: { analyser, data: new Uint8Array(analyser.fftSize) },
    push: (bytes) => { const copy = bytes.slice().buffer; node.port.postMessage(copy, [copy]); },
    clear: () => node.port.postMessage('clear'),
    close: () => ctx.close().catch(() => {}),
  };
}
