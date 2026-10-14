import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEs, EsError, hasEs, NO_ES_TEXT } from '../server/es.mjs';
import { buildInterviewerPrompt, loadModeBank, MODE_DEFAULTS } from '../server/interview.mjs';
import { buildGymPrompt, GYM_TYPES, GYM_LEVELS } from '../server/gym.mjs';
import { buildQScorePrompt, buildFinalPrompt } from '../server/live-scoring.mjs';
import { buildScoringPrompt, esText } from '../server/scoring.mjs';
import { buildGymScorePrompt } from '../server/gym-score.mjs';
import { splitExchanges } from '../server/exchanges.mjs';
import { startHarness } from './helpers/app-harness.mjs';

const strong = JSON.parse(readFileSync(new URL('../fixtures/strong-transcript.json', import.meta.url), 'utf8'));
const weak = JSON.parse(readFileSync(new URL('../fixtures/weak-transcript.json', import.meta.url), 'utf8'));
const noEs = (over = {}) => normalizeEs({ noEs: true, company: '', industry: '', role: '', mode: 'first', ...over });
// ES という語は、ES 節の置き換え文と節の見出しにだけ現れてよい
const stripAllowed = (p) => p.replaceAll(NO_ES_TEXT, '').replaceAll('# 応募者のエントリーシート', '');

test('normalizeEs: noEs は設問0件で通り、会社名・業界・職種は空でもよい。保存した形を読み直しても同じ', () => {
  const es = noEs();
  assert.deepEqual(es, { company: '', industry: '', role: '', mode: 'first', plan: 'standard', noEs: true, items: [] });
  assert.equal(hasEs(es), false);
  assert.deepEqual(normalizeEs(es), es);
  assert.equal(noEs({ company: 'A社', mode: 'midcareer' }).mode, 'midcareer');
});

test('normalizeEs: noEs 以外の空の items は従来どおり拒否。noEs に設問は付けられず、字数・型・種類の検査も効く', () => {
  assert.throws(() => normalizeEs({ company: 'A', industry: 'B', role: 'C', items: [] }), EsError);
  assert.throws(() => normalizeEs({ noEs: true, items: [{ title: 't', text: 'x' }] }), EsError);
  assert.throws(() => normalizeEs({ noEs: true, company: 5 }), EsError);
  assert.throws(() => normalizeEs({ noEs: true, company: 'あ'.repeat(101) }), EsError);
  assert.throws(() => normalizeEs({ noEs: true, mode: 'x' }), EsError);
  assert.equal(hasEs(normalizeEs(weak.es)), true);
});

test('面接官プロンプト: ES の節が置き換わり、論点は一般的なもの。全種類で未置換が無く、ES に頼る語が残らない', () => {
  for (const mode of Object.keys(MODE_DEFAULTS)) {
    for (const company of ['', 'テスト商事']) {
      const es = noEs({ mode, company, industry: company ? 'IT' : '', role: '' });
      const p = buildInterviewerPrompt(es, null, loadModeBank(mode));
      assert.ok(!p.includes('{{'), `${mode}: 未置換 ${p.match(/\{\{\w+\}\}/)?.[0]}`);
      assert.ok(p.includes(NO_ES_TEXT), mode);
      assert.ok(p.includes('一般的な論点'), mode);
      assert.ok(p.includes('「そのとき自分は具体的に何をしましたか」'), mode);
      assert.ok(!/ES|ＥＳ/.test(stripAllowed(p)), `${mode}: ${stripAllowed(p).match(/.{12}ES.{12}/)?.[0]}`);
      assert.equal(p.includes('志望している業界と会社'), company === '', `${mode} company=${company}`);
    }
  }
});

test('面接官プロンプト: 会社名が空でも文になる。ES ありのプロンプトに ES なし用の文は混ざらない', () => {
  const none = buildInterviewerPrompt(noEs(), null, loadModeBank('first'));
  assert.match(none, /あなたは 志望先が未定の企業の新卒採用の一次面接の面接官です。応募職種は未定です。/);
  const withEs = buildInterviewerPrompt(normalizeEs(weak.es), { focusPoints: [] }, loadModeBank('first'));
  assert.ok(withEs.includes(`あなたは ${weak.es.company}（${weak.es.industry}）の新卒採用`));
  assert.ok(withEs.includes('# このESで深掘りする論点'));
  assert.ok(!withEs.includes(NO_ES_TEXT) && !withEs.includes('志望している業界と会社') && !withEs.includes('一般的な論点'));
});

test('ジムのプロンプト: ES なしでも全タイプ×全強さで組み立てられ、ES に触れない', () => {
  for (const t of GYM_TYPES) {
    for (const l of GYM_LEVELS) {
      const p = buildGymPrompt({ es: noEs({ mode: 'second' }), bank: loadModeBank('second'), type: t.id, level: l.id });
      assert.ok(!p.includes('{{'), `${t.id}/${l.id}`);
      assert.ok(p.includes(NO_ES_TEXT));
      assert.ok(!/ES|ＥＳ/.test(stripAllowed(p)), `${t.id}/${l.id}: ${stripAllowed(p).match(/.{12}ES.{12}/)?.[0]}`);
    }
  }
  const withEs = buildGymPrompt({ es: normalizeEs(weak.es), bank: loadModeBank('first'), type: 'logic', level: 'normal' });
  assert.ok(withEs.includes('ES の記述との食い違い'));
});

test('採点プロンプト: ES なしは読み替えと ES 抜きの一貫性の基準が入り、ES ありは従来のまま', () => {
  const es0 = noEs();
  const es1 = normalizeEs(strong.es);
  const ex = splitExchanges(strong.turns)[0];
  const jobs = [];
  const builders = {
    qScore: (es) => buildQScorePrompt(es, ex),
    final: (es) => buildFinalPrompt(es, strong.turns, jobs),
    scoring: (es) => buildScoringPrompt(es, strong.turns),
    gym: (es) => buildGymScorePrompt(es, strong.turns, 'logic', 'normal'),
  };
  for (const [name, build] of Object.entries(builders)) {
    const p0 = build(es0);
    assert.ok(!p0.includes('{{'), name);
    assert.ok(p0.includes('# ES が無い面接の読み替え'), name);
    assert.ok(p0.includes('ESは提出されていません。'), name);
    const p1 = build(es1);
    assert.ok(!p1.includes('{{') && !p1.includes('ES が無い面接の読み替え'), name);
    assert.ok(p1.includes(es1.items[0].text), name);
    if (name !== 'gym') {
      assert.ok(p0.includes('回答どうしが食い違わず') && !p0.includes('ES と回答、回答どうし'), `${name}: 一貫性の基準`);
      assert.ok(p1.includes('ES と回答、回答どうしが食い違わず'), `${name}: ES ありの基準`);
    }
  }
  assert.equal(esText(es0), '企業: （未入力） / 業界: （未入力） / 職種: （未入力）\nESは提出されていません。');
});

test('API: ES なしのセッションは添削せずにすぐ ready。面接官プロンプトは ES の節が置き換わり、採点まで通ってレポートが出る', async () => {
  const h = await startHarness({ quota: { enabled: false } });
  try {
    const c = h.client();
    const res = await c.post('/api/sessions', { es: { noEs: true, company: '', industry: '', role: '', mode: 'first' } });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const s0 = await (await c.get(`/api/sessions/${id}`)).json();
    assert.equal(s0.status, 'ready');
    assert.equal(s0.noEs, true);
    assert.deepEqual(s0.es.items, []);
    assert.equal(h.calls.filter((x) => x.kind === 'es-item' || x.kind === 'es-plan').length, 0);
    const list = await (await c.get('/api/sessions')).json();
    assert.equal(list[0].noEs, true);
    assert.equal(list[0].company, '（会社名なし）');
    assert.equal((await c.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' })).status, 200);
    assert.ok(h.prompts[0].includes(NO_ES_TEXT));
    h.say(strong.turns.slice(0, 6));
    assert.equal((await c.post(`/api/sessions/${id}/end`, {})).status, 200);
    const done = await h.wait(c, id, (x) => x.status === 'done');
    assert.equal(done.status, 'done');
    assert.equal(done.report.scoring.axes.length, 6);
    const scoring = h.calls.filter((x) => x.kind === 'q-score' || x.kind === 'final');
    assert.ok(scoring.length >= 2 && scoring.every((x) => x.prompt.includes('ESは提出されていません。')));
    assert.equal(done.report.mode, 'first');
  } finally { await h.cleanup(); }
});

test('API: ES なしでも会社名などの上限と mode の検査が効く。ジムの ES なし開始は全項目が空でもよい', async () => {
  const h = await startHarness({ quota: { enabled: false } });
  try {
    const c = h.client();
    assert.equal((await c.post('/api/sessions', { es: { noEs: true, mode: 'zzz' } })).status, 400);
    assert.equal((await c.post('/api/sessions', { es: { noEs: true, company: 'あ'.repeat(101) } })).status, 400);
    const gym = { consent: true, type: 'logic', level: 'warmup', anxiety: [1, 1, 1, 1, 1, 1], quick: { company: '', industry: '', role: '' } };
    const r = await c.post('/api/gym/sessions', gym);
    assert.equal(r.status, 200);
    const { id } = await r.json();
    assert.equal((await c.post(`/api/sessions/${id}/realtime`, { sdp: 'v=0 x' })).status, 200);
    assert.ok(h.prompts[0].includes(NO_ES_TEXT) && h.prompts[0].includes('志望している業界と会社'));
  } finally { await h.cleanup(); }
});
