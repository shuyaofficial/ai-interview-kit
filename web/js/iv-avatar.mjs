// 面接画面の面接官の窓にアバターを入れ、声と応募者の発話から状態を切り替える。終了したら destroy する。
import { $ } from './dom.mjs';
import { createAvatar } from './avatar.mjs';
import { createAvatarFlow } from './avatar-state.mjs';

let cur = null; // { avatar, flow, last }

/** 窓に新しいアバターを置く（前のものは壊す）。接続前は idle。 */
export function mountIvAvatar() {
  destroyIvAvatar();
  cur = { avatar: createAvatar($('iv-avatar')), flow: createAvatarFlow(), last: 'idle' };
}

/** 毎フレーム呼ぶ。状態が変わったときだけ setState し、speaking の間は声の大きさで口を動かす。 */
export function updateIvAvatar(input, now = performance.now()) {
  if (!cur) return;
  const { state, level } = cur.flow.step(input, now);
  if (state !== cur.last) {
    cur.avatar.setState(state);
    cur.last = state;
  }
  if (state === 'speaking') cur.avatar.setLevel(level);
}

export function destroyIvAvatar() {
  if (!cur) return;
  cur.avatar.destroy();
  cur = null;
}

export const ivAvatarState = () => cur?.last ?? null;
