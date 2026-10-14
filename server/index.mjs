// 127.0.0.1 だけで待ち受ける HTTP サーバー。web/ の静的配信と JSON API。
import { createServer } from 'node:http';
import { mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { AXES, AXIS_IDS, SPEECH_GUIDE, axesFor } from './rubric.mjs';
import { getBridge } from './codex-bridge.mjs';
import { createLlm, KINDS } from './llm.mjs';
import { buildInterviewerPrompt, createRecorder, loadModeBank, listModes, KICKOFF_TEXT } from './interview.mjs';
import { computeSpeechMetrics, score, ES_CHAR_LIMIT } from './scoring.mjs';
import { createFinisher } from './finish.mjs';
import { createUserRoutes } from './routes-user.mjs';
import { createSessionRoutes } from './routes-session.mjs';
import { createVoiceRoutes } from './routes-voice.mjs';
import { voiceOptions, parseVoice, issueToken, GeminiError } from './gemini-live.mjs';
import { buildGymPrompt, gymModeInfo, gymConfig, nextStepHint, gymLabel } from './gym.mjs';
import { createExchangeTracker } from './exchanges.mjs';
import { createScorer } from './live-scoring.mjs';
import { normalizeEs, normalizeReview, EsError, DEFAULT_ITEMS, MAX_FIELD, MAX_ITEMS, hasEs, displayCompany } from './es.mjs';
import { createQuota, loadQuotaConfig, ensureDevice } from './quota.mjs';
import { createQuotaRoutes } from './routes-quota.mjs';
import { FEEDBACK_MAX_CHARS, FEEDBACK_AREAS } from '../web/js/labels.mjs';
import { createReviewManager } from './review-manager.mjs';
import { validateExtractBody, extractEs, ExtractInputError, MAX_EXTRACT_BODY } from './extract.mjs';
import { HttpError, readJson, writeJson, readBody, sendJson, serveStatic, SECURITY_HEADERS } from './http-util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const PIECE_RE = /^(?:q[0-9]{1,2}|plan)$/;

const newId = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(3).toString('hex')}`;
};

/**
 * @param {{bridge?: object, llm?: object, dataDir?: string, bankDir?: string, quota?: object, issueVoiceToken?: Function}} opts
 *   issueVoiceToken は Gemini の短期トークンの発行（テスト用の差し替え）。bridge は音声（realtime）用、llm は音声以外の LLM 用（プランで claude / codex を振り分ける）、quota は無料枠の設定の上書き（{freeInterviews, enabled}。テスト用）
 * @returns {{server: import('node:http').Server, init: () => Promise<void>, shutdown: () => Promise<void>}}
 */
export function createApp({ bridge = getBridge(), dataDir = process.env.DATA_DIR || join(ROOT, 'data'), llm = null, bankDir = undefined, quota: quotaOverride = null, issueVoiceToken = issueToken } = {}) {
  const sessionsDir = join(dataDir, 'sessions');
  const theLlm = llm ?? createLlm({ timingsFile: join(dataDir, 'timings.json') });
  const planIds = () => Object.keys(theLlm.plans.plans);
  const metas = new Map(); // id -> { id, createdAt, company, status, error, scores, mode, plan, review, compare }
  const live = new Map(); // id -> { threadId, recorder, scorer }
  const scorers = new Map(); // id -> scorer（面接中〜採点完了まで）
  const sse = new Map(); // id -> Set<res>
  const quota = createQuota({ dir: join(dataDir, 'quota'), config: loadQuotaConfig({ file: join(ROOT, 'server', 'quota.json'), override: quotaOverride }) });
  const sessDir = (id) => join(sessionsDir, id);
  const file = (id, name) => join(sessDir(id), `${name}.json`);

  const pendingWrites = new Set(); // 停止時に書き込みの途中を待つため
  let closed = false; // 停止後に裏の採点が終わっても、もう書かない
  async function setMeta(id, patch) {
    const next = { ...metas.get(id), ...patch };
    metas.set(id, next);
    if (closed) return next;
    const write = writeJson(file(id, 'meta'), next);
    pendingWrites.add(write);
    try { await write; } finally { pendingWrites.delete(write); }
    return next;
  }

  function emit(id, event) {
    for (const res of sse.get(id) ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const reviews = createReviewManager({ llm: theLlm, dir: sessDir, getMeta: (id) => metas.get(id), setMeta, emit, loadBank: (m) => loadModeBank(m, bankDir) });

  const finisher = createFinisher({ onCounted: (entry, id) => quota.record(entry.device, id), live, scorers, file, getMeta: (id) => metas.get(id), setMeta, emit, bridge, llm: theLlm, loadBank: (m) => loadModeBank(m, bankDir) });
  const userRoutes = createUserRoutes({ dataDir, metas, file, sessDir, setMeta, newId, bankDir, planIds, defaultPlan: theLlm.plans.default, voiceOf });
  const sessionRoutes = createSessionRoutes({ metas, setMeta, live, finisher });
  const voiceRoutes = createVoiceRoutes({ metas, live, emit, beginLive, abortLive, issueVoiceToken });
  const quotaRoutes = createQuotaRoutes({ quota, feedbackDir: join(dataDir, 'feedback') });

  async function init() {
    await theLlm.ready?.();
    await mkdir(sessionsDir, { recursive: true });
    for (const name of await readdir(sessionsDir)) {
      if (!ID_RE.test(name)) continue;
      const meta = await readJson(file(name, 'meta'));
      if (!meta) continue;
      metas.set(name, meta);
      if (['interviewing', 'scoring'].includes(meta.status)) {
        await finisher.repairSnapshot(name);
        await setMeta(name, { status: 'error', error: 'サーバーの再起動で処理が中断された' });
      } else if (meta.status === 'reviewing') {
        await reviews.interrupt(name);
      }
      if (metas.get(name).compare?.status === 'running') {
        await setMeta(name, { compare: { ...metas.get(name).compare, status: 'error', error: 'サーバーの再起動で処理が中断された' } });
      }
    }
  }

  async function createSession(body) {
    const voice = voiceOf(body.voice);
    let es;
    try { es = normalizeEs(body.es, { defaultPlan: theLlm.plans.default, plans: planIds() }); } catch (e) {
      if (e instanceof EsError) throw new HttpError(400, e.message);
      throw e;
    }
    if (!loadModeBank(es.mode, bankDir)) throw new HttpError(400, 'この面接の種類はまだ準備中');
    const id = newId();
    await mkdir(sessDir(id), { recursive: true });
    await writeJson(file(id, 'es'), es);
    const noEs = !hasEs(es);
    // ES が無ければ添削するものが無いので、すぐ面接できる状態（ready）にする
    await setMeta(id, { id, createdAt: new Date().toISOString(), company: displayCompany(es), noEs, status: noEs ? 'ready' : 'reviewing', error: null, scores: null, mode: es.mode, plan: es.plan, voice });
    if (!noEs) reviews.start(id, es);
    return { id };
  }

  async function getSession(id) {
    const meta = metas.get(id);
    if (!meta) throw new HttpError(404, 'セッションが無い');
    const [esRaw, report, transcript, scoringFile] = await Promise.all(['es', 'report', 'transcript', 'scoring'].map((n) => readJson(file(id, n))));
    const es = esRaw ? normalizeEs(esRaw, { defaultPlan: meta.plan ?? theLlm.plans.default }) : null;
    const planId = es?.plan ?? meta.plan ?? theLlm.plans.default;
    const alt = meta.compare?.status === 'done' ? await readJson(file(id, `report-${meta.compare.plan}`)) : null;
    const now = Date.now();
    const decorate = (p, chars = 0) => ({ ...p, chars, elapsedSec: p.startedAt ? ((p.doneAt ?? now) - p.startedAt) / 1000 : 0 });
    const snap = scorers.get(id)?.snapshot() ?? scoringFile;
    const rv = await reviews.view(id, es);
    return {
      id, createdAt: meta.createdAt, es, noEs: Boolean(es && !hasEs(es)), status: meta.status, error: meta.error ?? null, mode: meta.mode ?? 'first', plan: planId, voice: meta.voice ?? 'codex',
      esReview: es ? normalizeReview(rv.results, es) : null,
      review: { items: Object.fromEntries(Object.entries(rv.state.items).map(([k, p]) => [k, decorate(p, rv.chars[k])])), plan: decorate(rv.state.plan, rv.chars.plan) },
      scoring: snap ? { exchanges: snap.exchanges.map((x) => decorate(x, x.chars)), final: decorate(snap.final, snap.final.chars) } : null,
      report, transcript,
      gym: meta.gym ? { ...meta.gym, typeLabel: gymLabel(meta.gym.type, meta.gym.level), hint: nextStepHint({ level: meta.gym.level, stopped: meta.gym.stopped, anxietyAfter: meta.gym.anxietyAfter }) } : null,
      gymScore: meta.gym ? await readJson(file(id, 'gym')) : null,
      compare: meta.compare ? { ...meta.compare, elapsedSec: meta.compare.startedAt ? ((meta.compare.doneAt ?? now) - meta.compare.startedAt) / 1000 : 0 } : null,
      reportAlt: alt ? { plan: meta.compare.plan, report: alt } : null,
      expected: {
        sec: Object.fromEntries(KINDS.map((k) => [k, theLlm.expectedSec(k, planId)])),
        chars: Object.fromEntries(KINDS.map((k) => [k, theLlm.expectedChars?.(k, planId) ?? null])),
      },
    };
  }

  function listSessions() {
    return [...metas.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((m) => ({ id: m.id, createdAt: m.createdAt, company: m.company, noEs: Boolean(m.noEs), status: m.status, scores: m.scores ?? null, mode: m.mode ?? 'first', plan: m.plan ?? null, voice: m.voice ?? 'codex', gym: m.gym ? { type: m.gym.type, level: m.gym.level } : null }));
  }

  /** 声の指定を検証する（無効な指定・準備中の Gemini は 400）。 */
  function voiceOf(value) {
    try { return parseVoice(value); } catch (e) {
      if (e instanceof GeminiError) throw new HttpError(400, e.message);
      throw e;
    }
  }

  /** 面接を始める共通の準備（Codex・Gemini 共通）: 状態と無料枠の確認 → 面接官プロンプトと採点の用意 → live に登録して interviewing にする。 */
  async function beginLive(id, device) {
    const meta = metas.get(id);
    if (!['reviewing', 'ready', 'error'].includes(meta.status) || live.size > 0) throw new HttpError(409, 'この状態では面接を始められない');
    if (await readJson(file(id, 'transcript'))) throw new HttpError(409, 'この面接は終了済み');
    await quota.assertCanStart(device); // 無料枠の上限はサーバー側で強制する
    const es = normalizeEs(await readJson(file(id, 'es')), { defaultPlan: meta.plan ?? theLlm.plans.default });
    const plan = (await reviews.view(id, es)).results.plan;
    const bank = loadModeBank(es.mode, bankDir) ?? loadModeBank('first');
    const gym = meta.gym ?? null;
    const prompt = gym ? buildGymPrompt({ es, bank, type: gym.type, level: gym.level }) : buildInterviewerPrompt(es, plan, bank);
    // やりとりが閉じるたびに、裏で1問ずつ採点を始める
    const scorer = createScorer({
      run: (a) => theLlm.runStructured({ plan: es.plan, ...a }),
      es,
      modeInfo: gym ? gymModeInfo(bank, gym.type, gym.level) : bank,
      onChange: (snapshot) => { writeJson(file(id, 'scoring'), snapshot).catch(() => {}); emit(id, { type: 'scoring' }); },
    });
    const tracker = createExchangeTracker();
    const recorder = createRecorder({ onTurn: (turn) => { const ex = tracker.push(turn); if (ex) scorer.addExchange(ex); } });
    scorers.set(id, scorer);
    const entry = { threadId: null, device, recorder, scorer, es, gym, prevStatus: meta.status, prevError: meta.error ?? null };
    live.set(id, entry);
    await setMeta(id, { status: 'interviewing', error: null });
    return { entry, prompt };
  }

  /** beginLive のあと接続に失敗したとき、面接を始める前の状態へ戻す。 */
  async function abortLive(id, entry) {
    live.delete(id);
    scorers.delete(id);
    await setMeta(id, { status: entry.prevStatus, error: entry.prevError });
  }

  async function startRealtime(id, body, device) {
    const meta = metas.get(id);
    if (!meta) throw new HttpError(404, 'セッションが無い');
    if (typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0') || body.sdp.length > 100000) throw new HttpError(400, 'sdp が不正');
    if (meta.voice === 'gemini') throw new HttpError(409, 'この面接は別の声（Gemini）で作られている');
    const { entry, prompt } = await beginLive(id, device);
    const { recorder } = entry;
    try {
      const { threadId, answer } = await bridge.startRealtime({
        offerSdp: body.sdp,
        prompt,
        ...(process.env.REALTIME_MODEL ? { model: process.env.REALTIME_MODEL } : {}), // 音声モデルの比較用。未設定なら codex の既定
        onNotification: (msg) => {
          if (msg.method === 'thread/realtime/sdp') recorder.start();
          const ev = recorder.handle(msg.method, msg.params);
          if (ev) emit(id, ev);
          else if (msg.method === 'thread/realtime/error') emit(id, { type: 'error', message: msg.params.message });
          else if (msg.method === 'thread/realtime/closed') emit(id, { type: 'closed', reason: msg.params.reason ?? '' });
          else if (msg.method === 'bridge/exit') emit(id, { type: 'error', message: `app-server が終了した: ${msg.params.message}` });
        },
      });
      entry.threadId = threadId;
      return { answer };
    } catch (e) {
      await abortLive(id, entry);
      throw new HttpError(502, `面接を開始できなかった: ${e.message}`);
    }
  }

  // 面接官は応募者の発話を待つため、接続直後にこちらから開始を合図する（文は interview.mjs の KICKOFF_TEXT）
  async function kickoff(id) {
    const entry = live.get(id);
    if (!entry?.threadId) throw new HttpError(409, '進行中の面接が無い');
    if (entry.kickedOff) return { ok: true, already: true };
    entry.kickedOff = true;
    await bridge.appendText(entry.threadId, KICKOFF_TEXT, process.env.KICKOFF_ROLE || 'user');
    return { ok: true };
  }

  /** 同じ逐語録を別プランの一括採点で採点し直して並べる（プランの比較）。 */
  async function startCompare(id, body) {
    const meta = metas.get(id);
    if (!meta) throw new HttpError(404, 'セッションが無い');
    const transcript = await readJson(file(id, 'transcript'));
    if (meta.status !== 'done' || !transcript) throw new HttpError(409, '採点が終わっていない');
    if (meta.compare?.status === 'running') throw new HttpError(409, '比較の採点を実行中');
    const es = normalizeEs(transcript.es, { defaultPlan: meta.plan ?? theLlm.plans.default });
    const other = body.plan ?? planIds().find((p) => p !== es.plan);
    if (!planIds().includes(other) || other === es.plan) throw new HttpError(400, 'plan が不正（採点済みのプランとは別のプランを指定する）');
    await setMeta(id, { compare: { plan: other, status: 'running', startedAt: Date.now(), error: null } });
    (async () => {
      try {
        const r = await score(es, transcript.turns, { run: (a) => theLlm.runStructured({ kind: 'score', plan: other, ...a }) });
        await writeJson(file(id, `report-${other}`), {
          scoring: r.scoring, speech: computeSpeechMetrics(transcript.turns), evidenceViolations: r.evidenceViolations,
          compliance: r.compliance, plan: other, mode: es.mode, createdAt: new Date().toISOString(),
        });
        await setMeta(id, { compare: { ...metas.get(id).compare, status: 'done', doneAt: Date.now() } });
      } catch (e) {
        console.error(`[compare ${id}]`, e.message);
        await setMeta(id, { compare: { ...metas.get(id).compare, status: 'error', doneAt: Date.now(), error: e.message } });
      }
      emit(id, { type: 'compare' });
    })();
    return { ok: true, plan: other };
  }

  async function extract(body) {
    let input;
    try { input = validateExtractBody(body); } catch (e) {
      if (e instanceof ExtractInputError) throw new HttpError(400, e.message);
      throw e;
    }
    const plan = body.plan ?? theLlm.plans.default;
    if (!planIds().includes(plan)) throw new HttpError(400, 'plan が不正');
    try { return await extractEs(input, { llm: theLlm, plan }); } catch (e) {
      console.error('[extract]', e.message);
      throw new HttpError(502, `ES を読み取れなかった: ${e.message}`);
    }
  }

  function openEvents(id, req, res) {
    if (!metas.has(id)) throw new HttpError(404, 'セッションが無い');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const set = sse.get(id) ?? new Set();
    set.add(res);
    sse.set(id, set);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(keepalive); set.delete(res); });
  }

  function config() {
    const plans = planIds().map((id) => ({ id, label: theLlm.plans.plans[id].label ?? id, price: theLlm.plans.plans[id].price ?? '' }));
    const modes = listModes(bankDir);
    return {
      stages: modes.find((m) => m.id === 'first')?.stages ?? [],
      modes, plans, defaultPlan: theLlm.plans.default,
      defaultItems: DEFAULT_ITEMS, maxItems: MAX_ITEMS,
      expected: Object.fromEntries(KINDS.map((k) => [k, theLlm.expectedSec(k, theLlm.plans.default)])),
      gym: gymConfig(),
      voices: voiceOptions(),
      axes: AXES, axesNoEs: axesFor(true), axisIds: AXIS_IDS, speechGuide: SPEECH_GUIDE, esLimit: ES_CHAR_LIMIT, maxField: MAX_FIELD,
      feedback: { areas: FEEDBACK_AREAS, maxChars: FEEDBACK_MAX_CHARS },
    };
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET') throw new HttpError(405, 'GET のみ');
      return serveStatic(pathname, res);
    }
    if (method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'content-type は application/json');
    }
    const device = ensureDevice(req, res); // 初回だけ端末 ID の Cookie を発行する
    if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, config());
    if (await quotaRoutes(req, res, url, device) || await userRoutes(req, res, url) || await sessionRoutes(req, res, url) || await voiceRoutes(req, res, url, device)) return;
    if (pathname === '/api/es/extract' && method === 'POST') return sendJson(res, 200, await extract(await readBody(req, MAX_EXTRACT_BODY)));
    if (pathname === '/api/sessions') {
      if (method === 'GET') return sendJson(res, 200, listSessions());
      if (method === 'POST') return sendJson(res, 200, await createSession(await readBody(req)));
      throw new HttpError(405, 'method not allowed');
    }
    const retry = /^\/api\/sessions\/([^/]+)\/review\/([^/]+)\/retry$/.exec(pathname);
    if (retry) {
      const [, id, piece] = retry;
      if (!ID_RE.test(id)) throw new HttpError(400, 'id が不正（英数とハイフンのみ）');
      if (!PIECE_RE.test(piece)) throw new HttpError(400, 'itemId が不正');
      if (method !== 'POST') throw new HttpError(405, 'POST のみ');
      return sendJson(res, 200, await reviews.retry(id, piece));
    }
    const m = /^\/api\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
    if (!m) throw new HttpError(404, 'not found');
    const [, id, action] = m;
    if (!ID_RE.test(id)) throw new HttpError(400, 'id が不正（英数とハイフンのみ）');
    if (!action && method === 'GET') return sendJson(res, 200, await getSession(id));
    if (action === 'events' && method === 'GET') return openEvents(id, req, res);
    if (action === 'realtime' && method === 'POST') return sendJson(res, 200, await startRealtime(id, await readBody(req), device));
    if (action === 'kickoff' && method === 'POST') return sendJson(res, 200, await kickoff(id));
    if (action === 'end' && method === 'POST') return sendJson(res, 200, await finisher.endSession(id));
    if (action === 'compare' && method === 'POST') return sendJson(res, 200, await startCompare(id, await readBody(req)));
    throw new HttpError(404, 'not found');
  }

  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const url = new URL(req.url, 'http://localhost');
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      // tailscale serve --https 経由で開くときの名前（例: EXTRA_HOSTS=<名前>:8979）
      const extra = (process.env.EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
      if (![...hosts, ...extra].includes(req.headers.host)) throw new HttpError(403, 'Host が許可されていない');
      const origin = req.headers.origin;
      const origins = [...hosts.map((h) => `http://${h}`), ...extra.map((h) => `https://${h}`)];
      if (origin && !origins.includes(origin)) throw new HttpError(403, 'Origin が許可されていない');
      await route(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[http]', e);
      if (!res.headersSent) sendJson(res, status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
      else res.end();
    }
  });

  async function shutdown() {
    closed = true;
    for (const set of sse.values()) for (const res of set) res.end();
    for (const [, entry] of live) {
      if (entry.threadId) await bridge.stopRealtime(entry.threadId).catch(() => {});
    }
    live.clear();
    bridge.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
  }

  return { server, init, shutdown };
}

// ---- 直接起動 ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8979);
  const app = createApp({ quota: { enabled: false } }); // 配布版: 回数の制限なし
  await app.init();
  app.server.listen(port, '127.0.0.1', () => console.log(`AI 模擬面接: http://127.0.0.1:${port}/`));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
