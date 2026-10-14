// 面接官アバターの状態を決める小さな状態機械（DOM に触らない。tests/avatar-state.test.mjs で検査する）。
// 毎フレーム step({ connected, voice, micSpeaking }) を呼ぶ。
//   voice: 面接官の声の大きさ 0..1、micSpeaking: 応募者が話している（マイクの音量が続いている）か。
// 状態: 接続前=idle / 面接官の声が 0.05 を超えて 300ms 続いた間=speaking / 応募者が話している・待っている=listening /
//       応募者が話し終えた直後=nodding(1回) → 面接官が応答するまで=thinking
export const VOICE_ON = 0.05;
export const VOICE_HOLD_MS = 300; // 声が VOICE_ON を超えてから speaking にするまで
export const VOICE_RELEASE_MS = 250; // 声が切れてから speaking を解くまで（語の合間でちらつかせない）
export const MIN_UTTERANCE_MS = 700; // これより短い物音は「話し終えた」と数えない
export const NOD_MS = 1050;
export const THINK_MAX_MS = 15000; // 応答が来ないまま長く待つときは listening に戻す

export function createAvatarFlow() {
  let aboveSince = null;
  let belowSince = null;
  let speaking = false;
  let micSince = null;
  let afterAnswerAt = null; // 応募者が話し終えた時刻（応答を待っている間だけ入る）

  const reset = () => { aboveSince = null; belowSince = null; speaking = false; micSince = null; afterAnswerAt = null; };

  /** @returns {{state: 'idle'|'listening'|'speaking'|'thinking'|'nodding', level: number}} */
  function step({ connected, voice = 0, micSpeaking = false }, now) {
    if (!connected) { reset(); return { state: 'idle', level: 0 }; }
    if (voice > VOICE_ON) {
      belowSince = null;
      aboveSince ??= now;
      if (now - aboveSince >= VOICE_HOLD_MS) speaking = true;
    } else {
      aboveSince = null;
      belowSince ??= now;
      if (speaking && now - belowSince >= VOICE_RELEASE_MS) speaking = false;
    }
    if (speaking) {
      micSince = null;
      afterAnswerAt = null;
      return { state: 'speaking', level: voice };
    }
    if (micSpeaking) {
      micSince ??= now;
      afterAnswerAt = null;
      return { state: 'listening', level: 0 };
    }
    if (micSince != null) {
      if (now - micSince >= MIN_UTTERANCE_MS) afterAnswerAt = now;
      micSince = null;
    }
    if (afterAnswerAt != null) {
      const waited = now - afterAnswerAt;
      if (waited < NOD_MS) return { state: 'nodding', level: 0 };
      if (waited < THINK_MAX_MS) return { state: 'thinking', level: 0 };
      afterAnswerAt = null;
    }
    return { state: 'listening', level: 0 };
  }

  return { step, reset };
}
