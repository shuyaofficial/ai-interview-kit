// マイクの音（16kHz の AudioContext で受ける）を 50ms ごとに PCM16 にして main へ渡す。AudioWorklet は外部ファイルで読む（CSP のため）。
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(800);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.n += 1;
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
