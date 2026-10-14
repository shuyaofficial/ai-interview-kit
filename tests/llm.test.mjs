import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlm, loadPlans, DEFAULT_EXPECTED_SEC } from '../server/llm.mjs';

const plans = {
  default: 'standard',
  plans: {
    standard: { label: 'S', provider: 'claude', model: 'm-haiku', effort: null },
    premium: { label: 'P', provider: 'claude', model: 'm-sonnet', effort: 'high' },
    legacy: { label: 'L', provider: 'codex', model: 'm-codex', effort: 'low' },
  },
};

async function setup(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'llm-test-'));
  const calls = [];
  let clock = 0;
  const llm = createLlm({
    plans,
    timingsFile: join(dir, 'timings.json'),
    runClaude: async (a) => { calls.push(['claude', a]); clock += extra.stepMs ?? 1000; a.onProgress?.(42); return { ok: 'claude' }; },
    runCodex: async (a) => { calls.push(['codex', a]); clock += 1000; return { ok: 'codex' }; },
    now: () => clock,
  });
  return { dir, calls, llm, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('plans.json（配布版）: loadPlans が通り、全プランが codex（モデルは codex の既定に任せる）', () => {
  const p = loadPlans();
  assert.equal(p.default, 'standard');
  assert.deepEqual(Object.keys(p.plans), ['standard', 'premium']);
  for (const def of Object.values(p.plans)) {
    assert.equal(def.provider, 'codex');
    assert.equal('model' in def, false);
    assert.equal(def.overrides, undefined);
  }
});

test('loadPlans: overrides の形が不正なら例外（provider の上書きは不可）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-test-'));
  try {
    const bad = join(dir, 'plans.json');
    await writeFile(bad, JSON.stringify({ default: 's', plans: { s: { provider: 'claude', model: 'm', overrides: { final: { provider: 'codex' } } } } }));
    assert.throws(() => loadPlans(bad), /overrides\.final/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('resolvePlan / runStructured: overrides は該当の kind だけに効き、effort を省けばプランの値を引き継ぐ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-test-'));
  const calls = [];
  try {
    const llm = createLlm({
      plans: { default: 's', plans: { s: { label: 'S', provider: 'claude', model: 'm-haiku', effort: null, overrides: { final: { model: 'm-sonnet', effort: 'low' }, digest: { model: 'm-mid' } } } } },
      timingsFile: join(dir, 't.json'),
      runClaude: async (a) => { calls.push(a); return {}; },
    });
    for (const kind of ['q-score', 'final', 'es-item', 'digest']) await llm.runStructured({ kind, prompt: 'p', schema: {} });
    assert.deepEqual(calls.map((a) => [a.model, a.effort]), [['m-haiku', null], ['m-sonnet', 'low'], ['m-haiku', null], ['m-mid', null]]);
    assert.equal(llm.resolvePlan('s').model, 'm-haiku'); // kind なしは基本のモデル
    assert.equal(llm.resolvePlan('s', 'final').model, 'm-sonnet');
    assert.equal('overrides' in llm.resolvePlan('s', 'final'), false);
    await llm.flush();
    assert.ok(llm.expectedSec('final', 's') >= 0); // 記録のキーはプランIDのまま（kind:プラン）
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runStructured: provider=claude は claude ランナー、model と effort を渡す', async () => {
  const t = await setup();
  try {
    assert.deepEqual(await t.llm.runStructured({ kind: 'q-score', plan: 'premium', prompt: 'p', schema: { a: 1 }, files: ['/x.png'] }), { ok: 'claude' });
    assert.equal(t.calls.length, 1);
    const [who, a] = t.calls[0];
    assert.equal(who, 'claude');
    assert.equal(a.model, 'm-sonnet');
    assert.equal(a.effort, 'high');
    assert.deepEqual(a.files, ['/x.png']);
    assert.equal(a.prompt, 'p');
    await t.llm.runStructured({ kind: 'es-item', prompt: 'p', schema: {} }); // plan 省略 = 既定
    assert.equal(t.calls[1][1].model, 'm-haiku');
    assert.equal(t.calls[1][1].effort, null);
  } finally { await t.cleanup(); }
});

test('runStructured: provider=codex は codex ランナー。plan はオブジェクトでも文字列でもよい', async () => {
  const t = await setup();
  try {
    assert.deepEqual(await t.llm.runStructured({ plan: 'legacy', prompt: 'p', schema: {} }), { ok: 'codex' });
    assert.deepEqual(await t.llm.runStructured({ plan: { id: 'legacy' }, prompt: 'p', schema: {} }), { ok: 'codex' });
    assert.deepEqual(t.calls.map((c) => c[0]), ['codex', 'codex']);
    assert.equal(t.calls[0][1].model, 'm-codex');
    assert.equal(t.calls[0][1].effort, 'low');
  } finally { await t.cleanup(); }
});

test('runStructured: 未知のプランは例外（どのランナーも呼ばない）', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.llm.runStructured({ plan: 'gold', prompt: 'p', schema: {} }), /未知のプラン/);
    assert.equal(t.calls.length, 0);
  } finally { await t.cleanup(); }
});

test('expectedSec: 記録が無ければ初期値、あれば直近10件の中央値（kind × プランごと）', async () => {
  const t = await setup({ stepMs: 4000 });
  try {
    assert.deepEqual(DEFAULT_EXPECTED_SEC, { 'es-item': 25, 'es-plan': 25, 'es-extract': 30, 'q-score': 20, final: 40, score: 60 });
    assert.equal(t.llm.expectedSec('es-item', 'standard'), 25);
    assert.equal(t.llm.expectedSec('final', 'premium'), 40);
    await t.llm.runStructured({ kind: 'es-item', plan: 'standard', prompt: 'p', schema: {} });
    await t.llm.flush();
    assert.equal(t.llm.expectedSec('es-item', 'standard'), 4);
    assert.equal(t.llm.expectedSec('es-item', 'premium'), 25); // 別プランの記録は混ざらない
    assert.equal(t.llm.expectedChars('es-item', 'standard'), 42);
    const saved = JSON.parse(await readFile(join(t.dir, 'timings.json'), 'utf8'));
    assert.deepEqual(saved['es-item:standard'], [{ sec: 4, chars: 42 }]);
  } finally { await t.cleanup(); }
});

test('expectedSec: 中央値（偶数件は中央2つの平均）、11件目以降は古いものから捨てる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-test-'));
  try {
    let clock = 0;
    let step = 0;
    const secs = [10, 100, 30, 20, 40, 50, 60, 70, 80, 90, 5];
    const llm = createLlm({ plans, timingsFile: join(dir, 't.json'), runClaude: async () => { clock += secs[step] * 1000; step += 1; return {}; }, now: () => clock });
    for (let i = 0; i < 4; i += 1) await llm.runStructured({ kind: 'q-score', prompt: 'p', schema: {} });
    await llm.flush();
    assert.equal(llm.expectedSec('q-score', 'standard'), 25); // [10,100,30,20] → (20+30)/2
    for (let i = 4; i < 11; i += 1) await llm.runStructured({ kind: 'q-score', prompt: 'p', schema: {} });
    await llm.flush();
    const rows = JSON.parse(await readFile(join(dir, 't.json'), 'utf8'))['q-score:standard'];
    assert.equal(rows.length, 10);
    assert.equal(rows[0].sec, 100); // 最初の 10 が落ちた
    assert.equal(llm.expectedSec('q-score', 'standard'), 55); // [20,30,40,50,60,70,80,90,100,5] の中央値
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('失敗した呼び出しは記録しない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-test-'));
  try {
    const llm = createLlm({ plans, timingsFile: join(dir, 't.json'), runClaude: async () => { throw new Error('boom'); } });
    await assert.rejects(llm.runStructured({ kind: 'es-item', prompt: 'p', schema: {} }), /boom/);
    await llm.flush();
    assert.equal(llm.expectedSec('es-item', 'standard'), 25);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
