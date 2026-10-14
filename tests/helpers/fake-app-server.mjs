// テスト用の偽 app-server。stdio JSON-RPC の最小実装。
// 環境変数 FAKE_MODE: 'normal'（既定）| 'die-on-turn'（turn/start で自殺する）
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let threadN = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) return; // クライアントの拒否応答
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'fake' } });
  if (msg.method === 'thread/start') {
    threadN += 1;
    return send({ id: msg.id, result: { thread: { id: `t${threadN}` } } });
  }
  if (msg.method === 'turn/start') {
    if (process.env.FAKE_MODE === 'die-on-turn') process.exit(3);
    const threadId = msg.params.threadId;
    send({ id: msg.id, result: { turn: { id: 'u1' } } });
    // 想定外 item（commandExecution）と、正常な agentMessage を返す
    send({ method: 'item/completed', params: { threadId, item: { type: 'commandExecution' } } });
    send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: JSON.stringify({ ok: true, prompt: msg.params.input[0].text }) } } });
    return send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
  }
  if (msg.method === 'thread/realtime/start') {
    // 渡された model の有無を sdp に載せて返す。FAKE_MODE=reject-model なら model 付きを拒否する
    const { model } = msg.params;
    if (process.env.FAKE_MODE === 'reject-model' && model) return send({ id: msg.id, error: { code: -32600, message: `unknown realtime model: ${model}` } });
    send({ id: msg.id, result: {} });
    return send({ method: 'thread/realtime/sdp', params: { threadId: msg.params.threadId, sdp: `v=0 model=${model ?? 'none'} keys=${Object.keys(msg.params).join(',')}` } });
  }
  if (msg.method === 'no-reply') return;
  if (msg.method === 'ask-me-something') {
    // サーバー→クライアント要求を出し、拒否されたことを通知で返す
    send({ id: 900, method: 'item/commandExecution/requestApproval', params: {} });
    return send({ id: msg.id, result: {} });
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
