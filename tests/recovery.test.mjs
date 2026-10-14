import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/index.mjs';

const strong = JSON.parse(readFileSync(new URL('../fixtures/strong-transcript.json', import.meta.url), 'utf8'));
const AXIS_IDS = ['structure', 'specificity', 'ownership', 'consistency', 'motivation', 'responsiveness'];
const json = { 'content-type': 'application/json' };
const ROLE = { interviewer: 'assistant', candidate: 'user' };

/** 偽の LLM。failFinal 回だけ final を失敗させ、failQ に含まれる回答の質問は q-score を失敗させる。 */
function makeLlm(state) {
  return {
    plans: { default: 'standard', plans: { standard: { label: 'S' }, premium: { label: 'P' } } },
    expectedSec: () => 30,
    expectedChars: () => null,
    runStructured: async (a) => {
      state.calls.push(a.kind);
      if (a.kind === 'es-plan') return { focusPoints: [] };
      if (a.kind === 'es-item') return { scores: { prep: 3, specificity: 2, length: 4 }, comments: [], rewrite: 'r' };
      if (a.kind === 'q-score') {
        if (state.failQ && a.prompt.includes(state.failQ)) throw new Error('q boom');
        return { score: 4, quote: /candidate: (.{15})/.exec(a.prompt)[1], good: 'g', improve: 'i', modelAnswer: 'm' };
      }
      if (a.kind === 'final') {
        if (state.failFinal > 0) { state.failFinal -= 1; throw new Error('final boom'); }
        return { axes: AXIS_IDS.map((axis) => ({ axis, score: 4, reason: 'r', evidence: [] })), overall: { summary: 's', nextPractice: ['a', 'b', 'c'] }, compliance: { violations: [] } };
      }
      if (a.kind === 'gym') {
        state.gymPrompts.push(a.prompt);
        const ans = strong.turns[1].text;
        return { rebuttals: [{ turn: 0, question: strong.turns[0].text, fact: { met: true, quote: ans.slice(0, 12) }, responsibility: { met: false, quote: '' }, update: { met: false, quote: '' }, comment: 'c' }], summary: 's' };
      }
      throw new Error(`unexpected kind ${a.kind}`);
    },
  };
}

async function setup(state) {
  const prompts = [];
  let notify = null;
  const bridge = {
    startRealtime: async ({ onNotification, prompt }) => { prompts.push(prompt); notify = onNotification; return { threadId: `t${prompts.length}`, answer: 'v=0 fake' }; },
    stopRealtime: async () => {}, appendText: async () => {}, close: () => {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'ai-interview-rec-'));
  const app = createApp({ bridge, llm: makeLlm(state), dataDir: dir });
  await app.init();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const get = async (path) => (await fetch(base + path)).json();
  const wait = async (id, pred) => {
    let s;
    for (let i = 0; i < 150; i += 1) {
      s = await get(`/api/sessions/${id}`);
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 30));
    }
    return s;
  };
  const say = (threadId, turns) => {
    for (const t of turns) notify({ method: 'thread/realtime/transcript/done', params: { threadId, role: ROLE[t.role], text: t.text } });
  };
  return { app, base, post, get, wait, say, prompts, cleanup: async () => { await app.shutdown(); await new Promise((r) => setTimeout(r, 150)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

async function interview(t, turns, { stop = false } = {}) {
  const { id } = await (await t.post('/api/sessions', { es: strong.es })).json();
  assert.equal((await t.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' })).status, 200);
  t.say(`t${t.prompts.length}`, turns);
  assert.equal((await t.post(`/api/sessions/${id}/${stop ? 'stop' : 'end'}`, {})).status, stop ? 409 : 200);
  return id;
}

test('総評の失敗: 「もう一度作る」は済んだ質問を使い回し、final だけを走らせる。失敗していなければ 409', async () => {
  const state = { calls: [], failFinal: 1, failQ: null, gymPrompts: [] };
  const t = await setup(state);
  try {
    const id = await interview(t, strong.turns.slice(0, 6));
    const failed = await t.wait(id, (s) => s.status === 'error');
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /final boom/);
    assert.equal(failed.report, null);
    assert.ok(failed.transcript);
    assert.deepEqual(failed.scoring.exchanges.map((e) => e.status), ['done', 'done', 'done']);
    const qCalls = state.calls.filter((k) => k === 'q-score').length;
    assert.equal(qCalls, 3);

    assert.equal((await t.post(`/api/sessions/${id}/final/retry`)).status, 200);
    const done = await t.wait(id, (s) => s.status === 'done');
    assert.equal(done.status, 'done');
    assert.equal(done.report.scoring.axes.length, 6);
    assert.equal(done.report.scoring.questions.length, 3);
    assert.equal(state.calls.filter((k) => k === 'q-score').length, qCalls, '済んだ質問は採点し直さない');
    assert.equal(state.calls.filter((k) => k === 'final').length, 2);

    assert.equal((await t.post(`/api/sessions/${id}/final/retry`)).status, 409);
    assert.equal((await t.post('/api/sessions/nothing-here/final/retry')).status, 404);
    assert.equal((await t.post('/api/sessions/bad.id/final/retry')).status, 400);
    assert.equal((await fetch(`${t.base}/api/sessions/${id}/final/retry`)).status, 405);
  } finally { await t.cleanup(); }
});

test('final のやり直しも失敗したら error のまま。面接が終わっていないセッションは 409', async () => {
  const state = { calls: [], failFinal: 2, failQ: null, gymPrompts: [] };
  const t = await setup(state);
  try {
    const { id: early } = await (await t.post('/api/sessions', { es: strong.es })).json();
    assert.equal((await t.post(`/api/sessions/${early}/final/retry`)).status, 409);
    const id = await interview(t, strong.turns.slice(0, 4));
    await t.wait(id, (s) => s.status === 'error');
    assert.equal((await t.post(`/api/sessions/${id}/final/retry`)).status, 200);
    const again = await t.wait(id, (s) => s.status === 'error' && s.scoring.final.status === 'error' && state.calls.filter((k) => k === 'final').length === 2);
    assert.match(again.error, /final boom/);
    assert.equal((await t.post(`/api/sessions/${id}/final/retry`)).status, 200); // 3回目で通る
    assert.equal((await t.wait(id, (s) => s.status === 'done')).status, 'done');
  } finally { await t.cleanup(); }
});

test('質問ごとの失敗: 失敗した質問だけをやり直せ、済んだレポートの質問の並びに差し込まれる', async () => {
  const mark = strong.turns[3].text.slice(0, 15);
  const state = { calls: [], failFinal: 0, failQ: mark, gymPrompts: [] };
  const t = await setup(state);
  try {
    const id = await interview(t, strong.turns.slice(0, 6));
    const s = await t.wait(id, (x) => x.status === 'done');
    assert.deepEqual(s.scoring.exchanges.map((e) => e.status), ['done', 'error', 'done']);
    assert.equal(s.report.scoring.questions.length, 2);
    assert.equal((await t.post(`/api/sessions/${id}/exchanges/0/retry`)).status, 409, '採点済みは 409');
    assert.equal((await t.post(`/api/sessions/${id}/exchanges/9/retry`)).status, 404);
    assert.equal((await t.post(`/api/sessions/${id}/exchanges/x/retry`)).status, 404);
    state.failQ = null;
    assert.equal((await t.post(`/api/sessions/${id}/exchanges/1/retry`)).status, 200);
    const fixed = await t.wait(id, (x) => x.scoring.exchanges[1].status === 'done' && x.report.scoring.questions.length === 3);
    assert.equal(fixed.report.scoring.questions.length, 3);
    assert.equal(fixed.status, 'done');
    assert.equal(state.calls.filter((k) => k === 'final').length, 1, '総評は触らない');
    assert.equal(fixed.report.scoring.questions[1].question, fixed.scoring.exchanges[1].question);
  } finally { await t.cleanup(); }
});

test('gym: 同意なしは 400。ジムのプロンプトで面接し、「止める」で減点なしに終わり、練習の目安と終了後の記録が付く', async () => {
  const state = { calls: [], failFinal: 0, failQ: null, gymPrompts: [] };
  const t = await setup(state);
  try {
    await t.post('/api/sessions', { es: strong.es }); // 直近の ES として使われる
    const base = { type: 'logic', level: 'warmup', anxiety: [2, 2, 2, 2, 2, 2], reappraisal: '体が準備している' };
    assert.equal((await t.post('/api/gym/sessions', base)).status, 400);
    assert.equal((await t.post('/api/gym/sessions', { ...base, consent: false })).status, 400);
    assert.equal((await t.post('/api/gym/sessions', { ...base, consent: true, anxiety: [1] })).status, 400);
    assert.equal((await t.post('/api/gym/sessions', { ...base, consent: true, type: 'zzz' })).status, 400);
    const res = await t.post('/api/gym/sessions', { ...base, consent: true });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const ready = await t.get(`/api/sessions/${id}`);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.gym.type, 'logic');
    assert.equal(ready.es.company, strong.es.company);
    assert.equal((await t.get('/api/gym')).items.length, 0, '始めただけの回は履歴に出さない');
    assert.equal((await t.post(`/api/sessions/${id}/stop`)).status, 409, '面接中でなければ止められない');

    assert.equal((await t.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' })).status, 200);
    assert.ok(t.prompts.at(-1).includes('理詰め型・ウォームアップ') && t.prompts.at(-1).includes('止めたい'));
    t.say(`t${t.prompts.length}`, strong.turns.slice(0, 4));
    const stop = await (await t.post(`/api/sessions/${id}/stop`)).json();
    assert.equal(stop.status, 'scoring');
    const done = await t.wait(id, (s) => s.status === 'done' && s.gymScore);
    assert.equal(done.status, 'done');
    assert.equal(done.gym.stopped, true);
    assert.equal(done.report.gym.type, 'logic');
    assert.equal(done.gymScore.rebound.asked, 1);
    assert.equal(done.gymScore.recovery.count, 2);
    assert.ok(done.gymScore.recovery.answers[0].startSec >= 0);
    assert.equal(done.gym.hint.suggest, null, '止めた人には次の段階を自動では勧めない');
    assert.ok(state.gymPrompts[0].includes('理詰め型・ウォームアップ'));

    assert.equal((await t.post(`/api/sessions/${id}/gym/after`, { anxiety: [1, 1, 1, 1, 1, 1], stopReason: 'tired', selfTalk: true })).status, 200);
    assert.equal((await t.post(`/api/sessions/${id}/gym/after`, { anxiety: [1, 1] })).status, 400);
    const after = await t.get(`/api/sessions/${id}`);
    assert.deepEqual(after.gym.anxietyAfter, [1, 1, 1, 1, 1, 1]);
    assert.equal(after.gym.stopReason, 'tired');
    const hist = await t.get('/api/gym');
    assert.equal(hist.items.length, 1);
    assert.equal(hist.selfTalk.used.n, 1);
    const list = await t.get('/api/sessions');
    assert.equal(list.find((x) => x.id === id).gym.level, 'warmup');
  } finally { await t.cleanup(); }
});

test('gym: 応募者が何も話さずに止めても、エラーにせず stopped で残る。通常の面接には /stop を使えない', async () => {
  const state = { calls: [], failFinal: 0, failQ: null, gymPrompts: [] };
  const t = await setup(state);
  try {
    const quick = { consent: true, type: 'silent', level: 'worst', anxiety: [3, 3, 3, 3, 3, 3], quick: { company: 'A社', industry: 'IT', role: '開発' } };
    const { id } = await (await t.post('/api/gym/sessions', quick)).json();
    await t.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' });
    assert.equal((await (await t.post(`/api/sessions/${id}/stop`)).json()).status, 'stopped');
    const s = await t.get(`/api/sessions/${id}`);
    assert.equal(s.status, 'stopped');
    assert.equal(s.error, null);
    assert.equal(s.gym.stopped, true);
    const normal = await interview(t, strong.turns.slice(0, 2));
    assert.equal((await t.post(`/api/sessions/${normal}/stop`)).status, 409);
    assert.equal((await t.post('/api/gym/sessions', { ...quick, quick: { company: '', industry: 'IT', role: '開発' } })).status, 200); // ESなしでは会社名は任意
    assert.equal((await t.post('/api/gym/sessions', { ...quick, quick: { company: 'あ'.repeat(101), industry: 'IT', role: '開発' } })).status, 400);
  } finally { await t.cleanup(); }
});

test('lens と warmupの API: 保存・上書き・削除ができ、不正な入力は 400', async () => {
  const state = { calls: [], failFinal: 0, failQ: null, gymPrompts: [] };
  const t = await setup(state);
  try {
    const lens0 = await t.get('/api/lens');
    assert.equal(lens0.answers, null);
    assert.equal(lens0.items.length, 10);
    assert.equal((await t.post('/api/lens', { answers: [1, 2] })).status, 400);
    const saved = await (await t.post('/api/lens', { answers: [2, 4, 4, 6, 4, 6, 4, 4, 2, 4] })).json();
    assert.ok(saved.scores.extraversion <= 3 && saved.scores.neuroticism >= 5);
    const ov = await (await t.post('/api/lens/override', { bars: { extraversion: 6 }, hypothesis: 'one-number' })).json();
    assert.equal(ov.values.extraversion, 6);
    assert.equal(ov.hypothesis.id, 'one-number');
    assert.equal((await t.post('/api/lens/override', { bars: { extraversion: 9 } })).status, 400);
    assert.equal((await (await t.post('/api/lens/override', { bars: { extraversion: null }, hypothesis: null })).json()).override.bars.extraversion, undefined);
    assert.equal((await (await t.post('/api/lens/clear')).json()).answers, null);

    const w0 = await t.get('/api/warmup');
    assert.equal(w0.plan, null);
    assert.equal(w0.cards.length >= 5, true);
    assert.equal((await t.post('/api/warmup', { daysToReal: 1 })).status, 400);
    const w1 = await (await t.post('/api/warmup', { daysToReal: 3, intention: { when: '夜', where: '自室' } })).json();
    assert.equal(w1.plan.sessions.length, 3);
    assert.equal(w1.plan.current, 1);
    assert.equal((await t.post('/api/warmup/done', { n: 1, confidence: 9 })).status, 400);
    assert.equal((await t.post('/api/warmup/done', { n: 1, confidence: 3, sessionId: 'nothing' })).status, 400);
    const w2 = await (await t.post('/api/warmup/done', { n: 1, confidence: 3 })).json();
    assert.equal(w2.plan.sessions[0].done.confidence, 3);
    assert.equal((await (await t.post('/api/warmup/undo', { n: 1 })).json()).plan.sessions[0].done, null);
    assert.equal((await (await t.post('/api/warmup/clear')).json()).plan, null);
  } finally { await t.cleanup(); }
});
