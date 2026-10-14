import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, FEEDBACK_AREAS, applyLabels } from '../web/js/labels.mjs';
import { buildGymPrompt } from '../server/gym.mjs';
import { buildGymScorePrompt } from '../server/gym-score.mjs';
import { loadModeBank } from '../server/interview.mjs';
import { normalizeEs } from '../server/es.mjs';
import { STEPS } from '../server/warmup.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD = ['話しぶりレンズ', 'ならし運転', '想定外ジム'];
const NAMES = [...OLD, LABELS.lens.name, LABELS.warmup.name, LABELS.gym.name];
const DESCS = [LABELS.lens.desc, LABELS.warmup.desc, LABELS.gym.desc];

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'data') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|html|md|json)$/.test(f)) out.push(p);
  }
  return out;
}

test('表: 3機能の新しい名前と平易な一行説明', () => {
  assert.deepEqual([LABELS.lens.name, LABELS.warmup.name, LABELS.gym.name], ['話し方のクセチェック', '本番までの練習プラン', '手ごわい面接官で練習']);
  assert.equal(LABELS.warmup.desc, '面接の日までに、毎日なにを練習するかを組みます');
  assert.equal(LABELS.gym.desc, '理詰め・圧迫・無反応・時間制限の面接官で、答えにくい質問に慣れます');
  assert.ok(Object.isFrozen(LABELS) && Object.isFrozen(LABELS.gym));
});

test('集約: 名前と一行説明は labels.mjs の外に直書きされない（web/ と server/。コメントも含む）', () => {
  const files = [...walk(join(ROOT, 'web')), ...walk(join(ROOT, 'server'))].filter((p) => !p.endsWith('web/js/labels.mjs'));
  const hits = [];
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    for (const s of [...NAMES, ...DESCS]) if (text.includes(s)) hits.push(`${relative(ROOT, p)}: ${s}`);
  }
  assert.deepEqual(hits, []);
});

test('README・画面（index.html）に旧名が残っていない', () => {
  for (const f of ['README.md', 'web/index.html']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const s of [...OLD, 'レンズ']) assert.ok(!text.includes(s), `${f}: ${s}`);
  }
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes(LABELS.gym.name));
});

test('index.html: 3機能の見出しとカードは data-label で表から入る', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  for (const k of ['lens.name', 'lens.desc', 'lens.heading', 'warmup.name', 'warmup.desc', 'warmup.heading', 'gym.name', 'gym.desc', 'gym.heading']) assert.ok(html.includes(`data-label="${k}"`), k);
  const els = [{ dataset: { label: 'gym.name' }, textContent: '' }, { dataset: { label: 'zzz.x' }, textContent: 'keep' }];
  applyLabels({ querySelectorAll: () => els });
  assert.equal(els[0].textContent, LABELS.gym.name);
  assert.equal(els[1].textContent, 'keep');
});

test('サーバー側のプロンプトと練習プランの表示名も同じ表から出る', () => {
  const es = normalizeEs({ noEs: true });
  assert.ok(buildGymScorePrompt(es, [], 'logic', 'normal').includes(LABELS.gym.name));
  assert.ok(STEPS.find((s) => s.id === 'gym').title.includes(LABELS.gym.name));
  assert.ok(buildGymPrompt({ es, bank: loadModeBank('first'), type: 'logic', level: 'warmup' }).length > 100);
});

test('アンケートの機能名の選択肢は、新しい名前を表から引く', () => {
  const labels = FEEDBACK_AREAS.map((a) => a.label);
  for (const n of [LABELS.lens.name, LABELS.warmup.name, LABELS.gym.name, LABELS.quick.name]) assert.ok(labels.includes(n), n);
  assert.equal(new Set(FEEDBACK_AREAS.map((a) => a.id)).size, FEEDBACK_AREAS.length);
});
