// Gemini の音声（24kHz PCM16）を順に鳴らす。届いた塊をキューに積み、足りなければ無音。'clear' で割り込み時に捨てる。
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.pos = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = [];
        this.cur = null;
        this.pos = 0;
      } else {
        this.queue.push(new Int16Array(e.data));
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const first = out[0];
    for (let i = 0; i < first.length; i += 1) {
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.queue.shift() || null;
        this.pos = 0;
      }
      first[i] = this.cur ? this.cur[this.pos++] / 32768 : 0;
    }
    for (let c = 1; c < out.length; c += 1) out[c].set(first);
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
