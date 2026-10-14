// codex app-server（stdio JSON-RPC、1行1メッセージ）を子プロセス1本で共有するクライアント。
// realtime（音声面接）と structured（ES添削・採点）の両方をここから呼ぶ。
// 起動引数はスパイクで確かめた固定値。外すと本人の ~/.codex のフック・シェルが動くので変えない。
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const APP_SERVER_ARGS = [
  'app-server',
  '--disable', 'hooks',
  '--disable', 'shell_tool',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'shell_snapshot',
  '-c', 'mcp_servers={}',
];

export const STRUCTURED_DEV =
  'このスレッドは JSON を返すだけの採点専用。ユーザー指示ファイルにある長期記憶の追記・着手ゲート・宣言・委譲などの手順は一切実行しない。ツール（シェル・ファイル操作・検索）を使わず、与えられた本文だけを根拠に、指定スキーマの JSON だけを最終回答として返す。';

const EXPECTED_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'userMessage']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CodexBridge {
  #command;
  #args;
  #requestTimeoutMs;
  #logger;
  #child = null;
  #starting = null;
  #closed = false;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #realtime = new Map(); // threadId -> { cwd, unsubscribe, closed(Promise), resolveClosed }
  #stderrTail = '';

  constructor({ command = 'codex', args = APP_SERVER_ARGS, requestTimeoutMs = 60000, logger = console } = {}) {
    this.#command = command;
    this.#args = args;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#logger = logger;
  }

  /** 通知（method のみを持つ msg）を購読する。戻り値は購読解除関数。 */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** 子プロセスを（未起動なら）起動して initialize まで済ませる。 */
  ensureStarted() {
    if (this.#closed) return Promise.reject(new Error('bridge is closed'));
    if (!this.#starting) {
      this.#starting = this.#spawn().catch((e) => {
        this.#starting = null;
        throw e;
      });
    }
    return this.#starting;
  }

  async request(method, params, { timeoutMs } = {}) {
    await this.ensureStarted();
    return this.#rawRequest(method, params, timeoutMs);
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  close() {
    this.#closed = true;
    const child = this.#child;
    this.#child = null;
    this.#starting = null;
    this.#rejectAll(new Error('bridge closed'));
    for (const rt of this.#realtime.values()) rt.unsubscribe();
    this.#realtime.clear();
    if (child) child.kill('SIGTERM');
  }

  // ---- realtime ----

  /**
   * 音声面接を始める。offerSdp はブラウザの offer。onNotification にはこのスレッドの通知
   * （transcript/delta・done、error、closed など）と bridge/exit が渡る。
   * model は realtime モデルの上書き（このセッションだけ。null なら渡さず、codex の既定を使う）。
   * @returns {{threadId: string, answer: string}}
   */
  async startRealtime({ offerSdp, prompt, voice = 'juniper', model = null, onNotification, timeoutMs = 30000 }) {
    const cwd = await mkdtemp(join(tmpdir(), 'ai-interview-'));
    let threadId = null;
    let unsubscribe = () => {};
    try {
      const started = await this.request('thread/start', {
        cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      });
      threadId = started.thread.id;
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      let settle;
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sdp timeout')), timeoutMs);
        settle = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      });
      unsubscribe = this.subscribe((msg) => {
        if (msg.method === 'bridge/exit') {
          settle.reject(new Error(msg.params.message));
          onNotification?.(msg);
          resolveClosed();
          return;
        }
        if (msg.params?.threadId !== threadId) return;
        if (msg.method === 'thread/realtime/sdp') settle.resolve(msg.params.sdp);
        if (msg.method === 'thread/realtime/error') settle.reject(new Error(msg.params.message));
        onNotification?.(msg);
        if (msg.method === 'thread/realtime/closed') resolveClosed();
      });
      this.#realtime.set(threadId, { cwd, unsubscribe, closed });
      answer.catch(() => {}); // 先に reject されても未処理扱いにしない
      await this.request('thread/realtime/start', {
        threadId,
        outputModality: 'audio',
        transport: { type: 'webrtc', sdp: offerSdp },
        prompt,
        includeStartupContext: false,
        clientManagedHandoffs: true,
        version: 'v3',
        voice,
        ...(model ? { model } : {}),
      });
      return { threadId, answer: await answer };
    } catch (e) {
      unsubscribe();
      if (threadId) this.#realtime.delete(threadId);
      await rm(cwd, { recursive: true, force: true });
      throw e;
    }
  }

  async appendText(threadId, text, role = 'user') {
    return this.request('thread/realtime/appendText', { threadId, text, role });
  }

  /** 面接を止め、closed 通知（最大3秒）を待ってから後始末する。子プロセスが死んでいても後始末はする。 */
  async stopRealtime(threadId) {
    const rt = this.#realtime.get(threadId);
    try {
      await this.request('thread/realtime/stop', { threadId });
      if (rt) await Promise.race([rt.closed, sleep(3000)]);
    } finally {
      if (rt) {
        rt.unsubscribe();
        this.#realtime.delete(threadId);
        await rm(rt.cwd, { recursive: true, force: true });
      }
    }
  }

  // ---- structured（ES添削・採点）----

  /** schema に従う JSON を1回の turn で得る。1回 約80秒。 */
  // model/serviceTier はプランで切り替える。images は ES の画像（ローカルのパス）。
  // onProgress(chars) は回答の文字が届くたびに呼ばれる（進み具合の表示用）。
  async runStructured({ prompt, schema, effort = 'low', model = null, serviceTier = null, images = [], onProgress = null, timeoutMs = 280000 }) {
    const cwd = await mkdtemp(join(tmpdir(), 'ai-interview-'));
    let unsubscribe = () => {};
    let timer = null;
    try {
      const started = await this.request('thread/start', {
        cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: STRUCTURED_DEV,
      });
      const threadId = started.thread.id;
      let lastText = null;
      let streamed = 0;
      const done = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('structured timeout')), timeoutMs);
        unsubscribe = this.subscribe((msg) => {
          if (msg.method === 'bridge/exit') return reject(new Error(msg.params.message));
          if (msg.params?.threadId !== threadId) return;
          if (msg.method === 'item/agentMessage/delta') {
            streamed += msg.params.delta?.length ?? 0;
            onProgress?.(streamed);
          } else if (msg.method === 'item/completed') {
            const item = msg.params.item;
            if (!EXPECTED_ITEM_TYPES.has(item?.type)) {
              this.#logger.warn(`[codex-bridge] 想定外の item.type=${item?.type}（ツールが動いた可能性）`);
            }
            if (item?.type === 'agentMessage') lastText = item.text;
          } else if (msg.method === 'turn/completed') {
            const turn = msg.params.turn;
            if (turn?.status === 'failed' || turn?.status === 'interrupted') {
              return reject(new Error(`turn ${turn.status}: ${turn.error?.message ?? ''}`));
            }
            resolve(lastText);
          }
        });
      });
      done.catch(() => {});
      await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }, ...images.map((path) => ({ type: 'localImage', path }))],
        outputSchema: schema,
        effort,
        ...(model ? { model } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      const text = await done;
      if (!text) throw new Error('agentMessage が空');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`JSON として読めない出力: ${text.slice(0, 120)}`);
      }
    } finally {
      clearTimeout(timer);
      unsubscribe();
      await rm(cwd, { recursive: true, force: true });
    }
  }

  // ---- 内部 ----

  async #spawn() {
    const child = spawn(this.#command, this.#args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#stderrTail = '';
    child.stdin.on('error', () => {});
    child.on('error', (e) => this.#onDeath(child, e));
    child.on('exit', (code, sig) => this.#onDeath(child, new Error(`app-server が終了した (${code ?? sig}) ${this.#stderrTail.trim().slice(-300)}`)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { this.#stderrTail = (this.#stderrTail + d).slice(-2000); });
    child.stdout.setEncoding('utf8');
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.#onMessage(msg);
      }
    });
    await this.#rawRequest('initialize', {
      clientInfo: { name: 'ai-interview-app', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.#write({ method: 'initialized' });
  }

  #onDeath(child, err) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#starting = null; // 次の request で再起動する
    this.#rejectAll(err);
    if (!this.#closed) this.#emit({ method: 'bridge/exit', params: { message: err.message } });
  }

  #rejectAll(err) {
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.#pending.clear();
  }

  #write(msg) {
    if (!this.#child) throw new Error('app-server が動いていない');
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
  }

  #rawRequest(method, params, timeoutMs = this.#requestTimeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e);
      }
    });
  }

  #onMessage(msg) {
    if (msg.method && msg.id !== undefined) {
      // サーバー→クライアントの要求（承認など）は全部拒否する
      try { this.#write({ id: msg.id, error: { code: -32601, message: 'not supported' } }); } catch { /* 死んでいる */ }
      this.#emit({ method: 'bridge/serverRequestRejected', params: { method: msg.method } });
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? 'error'} ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.#emit(msg);
  }

  #emit(msg) {
    for (const fn of [...this.#listeners]) {
      try { fn(msg); } catch (e) { this.#logger.error('[codex-bridge] listener error', e); }
    }
  }
}

let shared = null;
/** プロセス内で1本だけの app-server を共有する。 */
export function getBridge() {
  if (!shared) shared = new CodexBridge();
  return shared;
}
