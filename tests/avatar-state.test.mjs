import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarFlow, VOICE_ON, VOICE_HOLD_MS, VOICE_RELEASE_MS, NOD_MS, MIN_UTTERANCE_MS, THINK_MAX_MS } from '../web/js/avatar-state.mjs';

/** 時刻 t（ms）から dt 刻みで frames 回、同じ入力を流し、最後の状態を返す。 */
function drive(flow, t0, ms, input, dt = 50) {
  let t = t0;
  let r;
  for (; t < t0 + ms; t += dt) r = flow.step(input, t);
  return { r, t };
}
const on = { connected: true, voice: 0.3, micSpeaking: false };
const quiet = { connected: true, voice: 0, micSpeaking: false };
const mic = { connected: true, voice: 0, micSpeaking: true };

test('接続前は idle。切断すると状態も戻る', () => {
  const f = createAvatarFlow();
  assert.equal(f.step({ connected: false, voice: 0.9, micSpeaking: true }, 0).state, 'idle');
  assert.equal(f.step(quiet, 100).state, 'listening');
  assert.equal(f.step({ ...quiet, connected: false }, 200).state, 'idle');
});

test('面接官の声: 0.05 を超えて 300ms 続いたら speaking、短い物音では speaking にしない', () => {
  assert.equal(VOICE_ON, 0.05);
  assert.equal(VOICE_HOLD_MS, 300);
  const f = createAvatarFlow();
  let { r, t } = drive(f, 0, VOICE_HOLD_MS - 50, on); // 250ms
  assert.equal(r.state, 'listening');
  ({ r, t } = drive(f, t, 100, quiet)); // 途切れたので数え直し
  ({ r, t } = drive(f, t, VOICE_HOLD_MS - 50, on));
  assert.equal(r.state, 'listening');
  ({ r, t } = drive(f, t, 200, on));
  assert.equal(r.state, 'speaking');
  assert.equal(r.level, 0.3);
  // 0.05 ちょうどは超えていない
  const g = createAvatarFlow();
  assert.equal(drive(g, 0, 1000, { ...on, voice: VOICE_ON }).r.state, 'listening');
});

test('speaking は、声が切れて少し経つと解け、語の合間では解けない', () => {
  const f = createAvatarFlow();
  let { t } = drive(f, 0, 600, on);
  let step = drive(f, t, VOICE_RELEASE_MS - 100, quiet);
  assert.equal(step.r.state, 'speaking');
  step = drive(f, step.t, 100, on);
  assert.equal(step.r.state, 'speaking');
  step = drive(f, step.t, VOICE_RELEASE_MS + 100, quiet);
  assert.equal(step.r.state, 'listening');
});

test('応募者が話している間は listening。話し終えた直後に 1 回 nodding、そのあと面接官が応答するまで thinking', () => {
  const f = createAvatarFlow();
  let { r, t } = drive(f, 0, 3000, mic);
  assert.equal(r.state, 'listening');
  ({ r, t } = drive(f, t, 50, quiet));
  assert.equal(r.state, 'nodding');
  const seen = [];
  for (let dt = 0; dt < 5000; dt += 50) seen.push(f.step(quiet, t + dt).state);
  const runs = seen.filter((s, i) => s !== seen[i - 1]);
  assert.deepEqual(runs, ['nodding', 'thinking'], 'nodding は 1 回だけ');
  assert.equal(seen[Math.floor(NOD_MS / 50) - 2], 'nodding');
  assert.equal(seen.at(-1), 'thinking');
  // 面接官が話し始める → speaking。話し終えたら listening（thinking には戻らない）
  ({ r, t } = drive(f, t + 5000, 500, on));
  assert.equal(r.state, 'speaking');
  ({ r } = drive(f, t, 1000, quiet));
  assert.equal(r.state, 'listening');
});

test('短い物音(700ms 未満)は話し終えたと数えない。応答が来ないまま長く待てば listening に戻る', () => {
  const f = createAvatarFlow();
  let { t } = drive(f, 0, MIN_UTTERANCE_MS - 100, mic);
  let r = drive(f, t, 500, quiet).r;
  assert.equal(r.state, 'listening');
  ({ t } = drive(f, 10000, 2000, mic));
  r = drive(f, t, 3000, quiet).r;
  assert.equal(r.state, 'thinking');
  r = drive(f, t + 3000, THINK_MAX_MS, quiet).r;
  assert.equal(r.state, 'listening');
});

test('応募者が考え中に話し始めたら listening に戻る（面接官の声を優先する）', () => {
  const f = createAvatarFlow();
  let { t } = drive(f, 0, 2000, mic);
  let r = drive(f, t, 1500, quiet);
  assert.equal(r.r.state, 'thinking');
  r = drive(f, r.t, 200, mic);
  assert.equal(r.r.state, 'listening');
  r = drive(f, r.t, 600, { connected: true, voice: 0.4, micSpeaking: true });
  assert.equal(r.r.state, 'speaking', '面接官が話し始めたら speaking が優先');
});
