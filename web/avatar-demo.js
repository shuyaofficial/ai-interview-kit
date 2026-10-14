// デモページの動作。CSP が inline script を許さないため外部ファイルにしてある。
import { createAvatar } from '/js/avatar.mjs';

const avatar = createAvatar(document.getElementById('stage'));
const buttons = [...document.querySelectorAll('#states button')];
const slider = document.getElementById('level');
const out = document.getElementById('level-out');
const auto = document.getElementById('auto');
let raf = 0;

const show = (state) => {
  avatar.setState(state);
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.state === state));
};
const level = (v) => { avatar.setLevel(v); out.textContent = Number(v).toFixed(2); };

for (const b of buttons) b.addEventListener('click', () => show(b.dataset.state));
slider.addEventListener('input', () => level(slider.value));
// 本番と同じく speaking 中は毎フレーム setLevel が呼ばれる想定
const tick = () => { avatar.setLevel(Number(slider.value)); raf = requestAnimationFrame(tick); };
raf = requestAnimationFrame(tick);

auto.addEventListener('click', () => {
  const on = auto.getAttribute('aria-pressed') !== 'true';
  auto.setAttribute('aria-pressed', String(on));
  if (!on) return;
  const t0 = performance.now();
  const loop = () => {
    if (auto.getAttribute('aria-pressed') !== 'true') return;
    const t = (performance.now() - t0) / 1000;
    const v = Math.max(0, 0.5 + 0.5 * Math.sin(t * 7) * Math.sin(t * 2.3));
    slider.value = String(v);
    level(v);
    requestAnimationFrame(loop);
  };
  loop();
});

window.__avatar = { show, level };
window.addEventListener('pagehide', () => { cancelAnimationFrame(raf); avatar.destroy(); });
