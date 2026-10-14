// API テスト用の共通部品: 偽 LLM・偽 realtime の app を立て、cookie を持つクライアントを返す。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

export const AXIS_IDS = ['structure', 'specificity', 'ownership', 'consistency', 'motivation', 'responsiveness'];
const ROLE = { interviewer: 'assistant', candidate: 'user' };

export function makeLlm(calls) {
  return {
    plans: { default: 'standard', plans: { standard: { label: 'スタンダード', price: '月500円（想定）' }, premium: { label: 'プレミアム', price: '月1000円（想定）' } } },
    expectedSec: () => 30,
    expectedChars: () => null,
    runStructured: async (a) => {
      calls.push(a);
      if (a.kind === 'es-plan') return { focusPoints: [] };
      if (a.kind === 'es-item') return { scores: { prep: 3, specificity: 2, length: 4 }, comments: [], rewrite: 'r' };
      if (a.kind === 'q-score') return { score: 4, quote: /candidate: (.{15})/.exec(a.prompt)[1], good: 'g', improve: 'i', modelAnswer: 'm' };
      if (a.kind === 'final') return { axes: AXIS_IDS.map((axis) => ({ axis, score: 4, reason: 'r', evidence: [] })), overall: { summary: 's', nextPractice: ['a', 'b', 'c'] }, compliance: { violations: [] } };
      if (a.kind === 'gym') return { rebuttals: [], summary: 's' };
      throw new Error(`unexpected kind ${a.kind}`);
    },
  };
}

/** opts: { quota, failConnect }。戻り値の client(cookie) は cookie を付けて呼ぶ関数群。 */
export async function startHarness({ quota = { freeInterviews: 1, enabled: true }, failConnect = false, issueVoiceToken = undefined } = {}) {
  const calls = [];
  const prompts = [];
  let notify = null;
  const bridge = {
    startRealtime: async ({ onNotification, prompt }) => {
      if (failConnect) throw new Error('connect boom');
      prompts.push(prompt);
      notify = onNotification;
      return { threadId: `t${prompts.length}`, answer: 'v=0 fake' };
    },
    stopRealtime: async () => {}, appendText: async () => {}, close: () => {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'ai-interview-v4-'));
  const app = createApp({ bridge, llm: makeLlm(calls), dataDir: dir, quota, ...(issueVoiceToken ? { issueVoiceToken } : {}) });
  await app.init();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = (cookie = '') => {
    const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
    return {
      get: (path) => fetch(base + path, { headers }),
      post: (path, body = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }),
    };
  };
  /** cookie 無しで /api/quota を呼び、Set-Cookie から端末 ID の cookie 文字列を取り出す。 */
  const newDevice = async () => {
    const res = await client().get('/api/quota');
    const set = res.headers.get('set-cookie');
    return { cookie: set.split(';')[0], setCookie: set };
  };
  const say = (turns) => {
    for (const t of turns) notify({ method: 'thread/realtime/transcript/done', params: { threadId: `t${prompts.length}`, role: ROLE[t.role], text: t.text } });
  };
  const wait = async (c, id, pred) => {
    let s;
    for (let i = 0; i < 150; i += 1) {
      s = await (await c.get(`/api/sessions/${id}`)).json();
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 30));
    }
    return s;
  };
  return {
    dir, base, calls, prompts, client, newDevice, say, wait,
    cleanup: async () => { await app.shutdown(); await new Promise((r) => setTimeout(r, 100)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
