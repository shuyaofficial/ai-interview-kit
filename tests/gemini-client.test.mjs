import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLive, b64ToBytes, bytesToB64 } from '../web/js/gemini-live.mjs';
import { createUploader } from '../web/js/voice-upload.mjs';

/** 偽の WebSocket。サーバーからの通知は push() で送り、クライアントが送ったものは sent に溜まる。 */
function makeFakeWs() {
  const sockets = [];
  class FakeWs {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
    push(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  return { FakeWs, sockets };
}

function setup({ maxReconnects = 3 } = {}) {
  const { FakeWs, sockets } = makeFakeWs();
  const log = { transcript: [], audio: [], interrupted: 0, states: [], closed: [], ready: 0 };
  const sink = {
    onReady: () => { log.ready += 1; },
    onState: (c) => log.states.push(c),
    onAudio: (b) => log.audio.push(b),
    onInterrupted: () => { log.interrupted += 1; },
    onTranscript: (e) => log.transcript.push(e),
    onClosed: (m) => log.closed.push(m),
  };
  const live = createGeminiLive({ url: 'wss://example.invalid/x?access_token=SECRETTOKEN', model: 'gemini-3.8-live', kickoffText: 'KICKOFF', sink, WebSocketImpl: FakeWs, maxReconnects, setTimer: (fn) => { queueMicrotask(fn); return 0; } });
  return { live, sockets, log };
}
const tick = () => new Promise((r) => setImmediate(r));

test('接続: setup はモデルと sessionResumption だけ。setupComplete で ready になり、kickoff の文を1回だけ送る', async () => {
  const { live, sockets, log } = setup();
  const started = live.start();
  await tick();
  const [ws] = sockets;
  assert.deepEqual(ws.sent[0], { setup: { model: 'models/gemini-3.8-live', sessionResumption: {} } });
  assert.ok(!JSON.stringify(ws.sent).includes('systemInstruction'), 'プロンプトはブラウザに無い');
  ws.push({ setupComplete: {} });
  await started;
  assert.equal(log.ready, 1);
  assert.deepEqual(ws.sent[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: 'KICKOFF' }] }], turnComplete: true } });
  assert.deepEqual(log.states, [true]);
});

test('字幕: 面接官の声・字幕・応募者の字幕を Codex と同じ delta/done に直す', async () => {
  const { live, sockets, log } = setup();
  const started = live.start();
  await tick();
  const ws = sockets[0];
  ws.push({ setupComplete: {} });
  await started;
  // 応募者の発話（途中）
  ws.push({ serverContent: { inputTranscription: { text: '私は' } } });
  ws.push({ serverContent: { inputTranscription: { text: '学生です' } } });
  // 面接官が話し始める → 応募者は done。音声は 24kHz PCM16 のバイト列として渡る
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);
  ws.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: bytesToB64(pcm) } }] } } });
  ws.push({ serverContent: { outputTranscription: { text: 'ありがとうございます。' } } });
  ws.push({ serverContent: { outputTranscription: { text: '次に進みます。' } } });
  ws.push({ serverContent: { generationComplete: true } });
  ws.push({ serverContent: { turnComplete: true } }); // 2度目は何も出さない
  assert.deepEqual(log.transcript, [
    { role: 'user', kind: 'delta', text: '私は' },
    { role: 'user', kind: 'delta', text: '学生です' },
    { role: 'user', kind: 'done', text: '私は学生です' },
    { role: 'assistant', kind: 'delta', text: 'ありがとうございます。' },
    { role: 'assistant', kind: 'delta', text: '次に進みます。' },
    { role: 'assistant', kind: 'done', text: 'ありがとうございます。次に進みます。' },
  ]);
  assert.deepEqual([...log.audio[0]], [...pcm]);
});

test('割り込み: interrupted で再生を捨て、面接官の発話をそこまでで確定する', async () => {
  const { live, sockets, log } = setup();
  const started = live.start();
  await tick();
  const ws = sockets[0];
  ws.push({ setupComplete: {} });
  await started;
  ws.push({ serverContent: { outputTranscription: { text: 'では、学生時代に' } } });
  ws.push({ serverContent: { interrupted: true } });
  assert.equal(log.interrupted, 1);
  assert.deepEqual(log.transcript.at(-1), { role: 'assistant', kind: 'done', text: 'では、学生時代に' });
});

test('音声の送信: 16kHz PCM16 を base64 で。ready 前とつなぎ直しの間は捨てる', async () => {
  const { live, sockets } = setup();
  const started = live.start();
  await tick();
  const ws = sockets[0];
  live.sendAudio(new Int16Array([1, 2]).buffer); // ready 前
  assert.equal(ws.sent.filter((m) => m.realtimeInput).length, 0);
  ws.push({ setupComplete: {} });
  await started;
  live.sendAudio(new Int16Array([1, -2]).buffer);
  const msg = ws.sent.find((m) => m.realtimeInput);
  assert.equal(msg.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual([...new Int16Array(b64ToBytes(msg.realtimeInput.audio.data).buffer)], [1, -2]);
});

test('つなぎ直し: 接続が切れたら直近の handle を付けて同じ URL へ。kickoff は繰り返さない', async () => {
  const { live, sockets, log } = setup();
  const started = live.start();
  await tick();
  sockets[0].push({ setupComplete: {} });
  await started;
  sockets[0].push({ sessionResumptionUpdate: { newHandle: 'H1', resumable: true } });
  sockets[0].push({ sessionResumptionUpdate: { newHandle: 'H2', resumable: true } });
  sockets[0].drop(1006);
  await tick(); await tick();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, sockets[0].url);
  assert.deepEqual(sockets[1].sent[0], { setup: { model: 'models/gemini-3.8-live', sessionResumption: { handle: 'H2' } } });
  sockets[1].push({ setupComplete: {} });
  assert.equal(sockets[1].sent.filter((m) => m.clientContent).length, 0);
  assert.equal(log.ready, 1);
  assert.deepEqual(log.states, [true, false, true]);
  assert.deepEqual(log.closed, []);
});

test('切断: handle が無い・つなぎ直しの上限を超えたら onClosed。理由からトークンを伏せる。起動前の切断は start が reject', async () => {
  const a = setup();
  const started = a.live.start();
  await tick();
  a.sockets[0].drop(1008, 'bad access_token=SECRETTOKEN here');
  await assert.rejects(started, (e) => { assert.ok(!e.message.includes('SECRETTOKEN'), e.message); return /1008/.test(e.message); });

  const b = setup({ maxReconnects: 1 });
  const s2 = b.live.start();
  await tick();
  b.sockets[0].push({ setupComplete: {} });
  await s2;
  b.sockets[0].push({ sessionResumptionUpdate: { newHandle: 'H' } });
  b.sockets[0].drop(1006);
  await tick(); await tick();
  b.sockets[1].drop(1011, 'internal');
  await tick();
  assert.equal(b.log.closed.length, 1);
  assert.match(b.log.closed[0], /1011/);

  const c = setup();
  const s3 = c.live.start();
  await tick();
  c.sockets[0].push({ setupComplete: {} });
  await s3;
  c.live.close();
  assert.deepEqual(c.log.closed, []); // 自分で閉じたときは通知しない
});

test('字幕のアップロード: 同じ話者の delta は1つにまとめ、done はすぐ送り、順番を守る。ready は最初の送信に付く', async () => {
  const sent = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const timers = [];
  const up = createUploader({
    send: async (body) => { sent.push(body); if (sent.length === 1) await gate; },
    onError: (e) => { throw e; },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  up.markReady();
  up.push({ role: 'user', kind: 'delta', text: 'あ' });
  up.push({ role: 'user', kind: 'delta', text: 'い' });
  up.push({ role: 'assistant', kind: 'delta', text: 'う' });
  up.push({ role: 'user', kind: 'done', text: 'あい' }); // done は待たずに送る
  release();
  await up.flush();
  assert.deepEqual(sent[0], { events: [], ready: true });
  assert.deepEqual(sent[1].events, [
    { role: 'user', kind: 'delta', text: 'あい' },
    { role: 'assistant', kind: 'delta', text: 'う' },
    { role: 'user', kind: 'done', text: 'あい' },
  ]);
  assert.equal(sent.length, 2);
});

test('字幕のアップロード: 送信に失敗しても次の送信は続く（onError に渡す）', async () => {
  const errors = [];
  let n = 0;
  const up = createUploader({ send: async () => { n += 1; if (n === 1) throw new Error('boom'); }, onError: (e) => errors.push(e.message), setTimer: () => 0, clearTimer: () => {} });
  up.push({ role: 'user', kind: 'done', text: 'a' });
  up.push({ role: 'user', kind: 'done', text: 'b' });
  await up.flush();
  assert.deepEqual(errors, ['boom']);
  assert.equal(n, 2);
});
