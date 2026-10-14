// 面接官アバター（インライン SVG）。色と線は SVG 属性、動きは avatar.css のクラスで付ける（CSP で style 属性が使えないため）。
// 使い方: const av = createAvatar(el); av.setState('speaking'); av.setLevel(0.4); av.destroy();

const NS = 'http://www.w3.org/2000/svg';

const C = {
  ink: '#1f2328',
  skin: '#f6dcc4',
  skinShade: '#ecbf9c',
  cheek: '#f3a99d',
  hair: '#343a46',
  hairLight: '#5b6475',
  suit: '#38425a',
  suitLight: '#46526f',
  shirt: '#ffffff',
  tie: '#3f63a8',
  mouth: '#7b3a3a',
  tongue: '#e98b8b',
  yellow: '#f7c948',
  desk: '#f4f1ea',
};

export const STATES = ['idle', 'listening', 'speaking', 'thinking', 'nodding'];

// 口の開き 3 段階の境目（上がるとき）。下がるときは HYSTERESIS 分だけ余計に下がるまで戻さない。
const MOUTH_UP = [0.06, 0.35, 0.65];
const HYSTERESIS = 0.04;
const MOUTH_HOLD_MS = 60;
const NOD_MS = 1050;
const SOFT_NOD_MS = 1500;
const BLINK_MS = 200;

function node(tag, attrs = {}, children = []) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const child of children) el.appendChild(child);
  return el;
}

const g = (cls, children, attrs = {}) => node('g', { class: cls, ...attrs }, children);
const path = (d, attrs = {}) => node('path', { d, ...attrs });
const line = (x1, y1, x2, y2, attrs = {}) => node('line', { x1, y1, x2, y2, ...attrs });
const ellipse = (cx, cy, rx, ry, attrs = {}) => node('ellipse', { cx, cy, rx, ry, ...attrs });

const stroke = (w, color = C.ink) => ({ stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const outlined = (fill, w = 4) => ({ fill, ...stroke(w) });

function buildBody() {
  return g('av-body', [
    // 上着
    path('M72 340 C70 268 104 236 156 224 L244 224 C296 236 330 268 328 340 Z', outlined(C.suit)),
    // 首
    path('M178 184 L178 230 Q200 246 222 230 L222 184 Z', outlined(C.skinShade)),
    // シャツ（V 字）と襟
    path('M162 222 L200 288 L238 222 Z', outlined(C.shirt, 3)),
    path('M166 223 L198 243 L176 260 Z', outlined(C.shirt, 3)),
    path('M234 223 L202 243 L224 260 Z', outlined(C.shirt, 3)),
    // 襟のあたり（ラペル）
    path('M158 226 L162 224 L200 288 L196 316 C176 290 164 260 158 226 Z', outlined(C.suitLight, 3)),
    path('M242 226 L238 224 L200 288 L204 316 C224 290 236 260 242 226 Z', outlined(C.suitLight, 3)),
    // ネクタイ
    path('M191 266 L209 266 L216 324 L200 336 L184 324 Z', outlined(C.tie, 3)),
    node('rect', { x: 187, y: 250, width: 26, height: 18, rx: 5, ...outlined(C.tie, 3) }),
  ]);
}

function buildDesk() {
  return g('av-desk', [
    // 枠より広く描く。svg 要素の箱で切られるので、枠の縦横比が違っても机が途切れない
    node('rect', { x: -600, y: 340, width: 1600, height: 400, fill: C.desk }),
    line(-600, 340, 1000, 340, stroke(4)),
  ]);
}

function sleeve(x1, y1, x2, y2) {
  return [
    line(x1, y1, x2, y2, stroke(44)),
    line(x1, y1, x2, y2, { ...stroke(36, C.suit), 'stroke-linecap': 'round' }),
  ];
}

function buildHands() {
  const left = g('av-hand-l', [
    ...sleeve(98, 322, 140, 322),
    node('rect', { x: 136, y: 308, width: 14, height: 30, rx: 4, ...outlined(C.shirt, 3) }),
    ellipse(186, 322, 36, 18, outlined(C.skin, 4)),
  ]);
  const right = g('av-hand-r', [
    ...sleeve(302, 322, 260, 322),
    node('rect', { x: 250, y: 308, width: 14, height: 30, rx: 4, ...outlined(C.shirt, 3) }),
    ellipse(214, 322, 36, 18, outlined(C.skin, 4)),
    path('M194 307 L203 326 M207 306 L213 327 M220 307 L224 326 M232 310 L234 325', stroke(3)),
  ]);
  return g('av-hands', [left, right]);
}

function buildHead() {
  const face = [
    ellipse(133, 140, 11, 15, outlined(C.skin, 4)),
    ellipse(267, 140, 11, 15, outlined(C.skin, 4)),
    ellipse(200, 128, 67, 71, outlined(C.skin, 4)),
    ellipse(148, 164, 14, 9, { fill: C.cheek, opacity: 0.55 }),
    ellipse(252, 164, 14, 9, { fill: C.cheek, opacity: 0.55 }),
    path('M196 157 Q200 161 204 157', stroke(3, C.skinShade)),
  ];

  const openEyes = g('av-eyes-open', [
    g('av-gaze', [
      g('av-eye', [ellipse(171, 142, 9.5, 12, { fill: C.ink }), ellipse(174, 137, 3.4, 3.4, { fill: '#ffffff' })]),
      g('av-eye', [ellipse(229, 142, 9.5, 12, { fill: C.ink }), ellipse(232, 137, 3.4, 3.4, { fill: '#ffffff' })]),
    ]),
  ]);
  const happyEyes = g('av-eyes-happy', [
    path('M159 146 Q171 128 183 146', { fill: 'none', ...stroke(5.5) }),
    path('M217 146 Q229 128 241 146', { fill: 'none', ...stroke(5.5) }),
  ]);
  const brows = g('av-brows', [
    path('M157 124 Q171 117 186 122', { fill: 'none', class: 'av-brow av-brow-l', ...stroke(4, C.hair) }),
    path('M214 122 Q229 117 243 124', { fill: 'none', class: 'av-brow av-brow-r', ...stroke(4, C.hair) }),
  ]);

  const mouths = g('av-mouths', [
    path('M183 167 Q200 181 217 167', { class: 'av-mouth av-mouth-smile', fill: 'none', ...stroke(4.5) }),
    path('M188 172 Q200 169 214 173', { class: 'av-mouth av-mouth-think', fill: 'none', ...stroke(4.5) }),
    path('M184 166 Q200 173 216 166 Q214 179 200 179 Q186 179 184 166 Z', { class: 'av-mouth av-mouth-1', ...outlined(C.mouth, 4) }),
    g('av-mouth av-mouth-2', [
      path('M182 165 Q200 172 218 165 Q216 186 200 186 Q184 186 182 165 Z', outlined(C.mouth, 4)),
      ellipse(200, 180, 9, 4.5, { fill: C.tongue }),
    ]),
    g('av-mouth av-mouth-3', [
      path('M180 164 Q200 171 220 164 Q220 192 200 192 Q180 192 180 164 Z', outlined(C.mouth, 4)),
      ellipse(200, 186, 11, 5.5, { fill: C.tongue }),
    ]),
  ]);

  const hair = [
    path(
      'M130 140 C110 102 116 44 166 30 C194 22 234 24 254 38 C294 54 292 106 270 140 ' +
        'C272 122 266 108 257 99 Q255 115 240 114 Q234 104 226 96 Q216 112 198 113 Q188 104 181 97 ' +
        'Q172 112 156 111 Q142 118 130 140 Z',
      outlined(C.hair, 4),
    ),
    path('M170 38 C188 50 196 70 190 92', { fill: 'none', ...stroke(3.5, C.hairLight) }),
    path('M214 36 C232 48 248 66 252 88', { fill: 'none', ...stroke(3.5, C.hairLight) }),
    path('M140 78 C134 92 132 106 136 120', { fill: 'none', ...stroke(3.5, C.hairLight) }),
  ];

  return g('av-head', [...face, brows, openEyes, happyEyes, mouths, ...hair]);
}

function buildThinkingArm() {
  return g('av-arm-think', [
    line(136, 316, 190, 238, stroke(46)),
    line(136, 316, 178, 255, stroke(38, C.suit)),
    line(178, 255, 190, 238, { ...stroke(38, C.shirt), 'stroke-linecap': 'butt' }),
    // あごに当てた手
    path('M182 234 C176 212 194 197 220 199 C242 200 252 214 246 228 C240 242 210 246 192 242 Z', outlined(C.skin, 4)),
    path('M224 201 L228 217 M237 205 L239 221', stroke(3)),
    path('M190 220 C200 227 210 227 217 222', { fill: 'none', ...stroke(3) }),
  ]);
}

function buildSparks() {
  const y = (d) => path(d, { fill: 'none', ...stroke(7, C.yellow) });
  return g('av-sparks', [
    g('av-spark av-spark-l', [y('M98 112 L74 102'), y('M98 140 L72 144')]),
    g('av-spark av-spark-r', [y('M302 112 L326 102'), y('M302 140 L328 144')]),
    g('av-spark av-spark-arc', [y('M298 92 Q316 122 302 154'), y('M314 86 Q336 124 318 162')]),
  ]);
}

function buildSvg() {
  return node(
    'svg',
    {
      class: 'av-root av-s-idle av-m0',
      viewBox: '0 0 400 360',
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'xMidYMax meet',
      role: 'img',
      'aria-label': '面接官（AI）',
      focusable: 'false',
    },
    [buildSparks(), buildBody(), buildDesk(), buildHands(), buildHead(), buildThinkingArm()],
  );
}

const rand = (min, max) => min + Math.random() * (max - min);

export function createAvatar(container) {
  const svg = buildSvg();
  container.appendChild(svg);

  let state = 'idle';
  let mouth = 0;
  let mouthChangedAt = 0;
  let alive = true;
  const timers = { blink: 0, softNod: 0, nod: 0, blinkEnd: 0, softNodEnd: 0 };

  const clear = (key) => { clearTimeout(timers[key]); timers[key] = 0; };

  const scheduleBlink = () => {
    timers.blink = setTimeout(() => {
      svg.classList.add('av-blinking');
      timers.blinkEnd = setTimeout(() => svg.classList.remove('av-blinking'), BLINK_MS);
      scheduleBlink();
    }, rand(3000, 6000));
  };

  const scheduleSoftNod = () => {
    clear('softNod');
    if (state !== 'listening') return;
    timers.softNod = setTimeout(() => {
      svg.classList.add('av-nod-soft');
      timers.softNodEnd = setTimeout(() => svg.classList.remove('av-nod-soft'), SOFT_NOD_MS);
      scheduleSoftNod();
    }, rand(4000, 8000));
  };

  const paintMouth = (step) => {
    mouth = step;
    mouthChangedAt = performance.now();
    svg.classList.remove('av-m0', 'av-m1', 'av-m2', 'av-m3');
    svg.classList.add(`av-m${step}`);
  };

  const setState = (next) => {
    if (!alive) return;
    if (!STATES.includes(next)) {
      console.warn(`avatar: 未知の state "${next}"`);
      return;
    }
    clear('nod');
    clear('softNod');
    clear('softNodEnd');
    svg.classList.remove('av-nod-soft');
    for (const s of STATES) svg.classList.remove(`av-s-${s}`);
    svg.classList.add(`av-s-${next}`);
    state = next;
    if (next !== 'speaking') paintMouth(0);
    if (next === 'listening') scheduleSoftNod();
    if (next === 'nodding') timers.nod = setTimeout(() => setState('listening'), NOD_MS);
  };

  const setLevel = (level) => {
    if (!alive || state !== 'speaking') return;
    const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    let target = 0;
    while (target < 3 && v >= MOUTH_UP[target]) target += 1;
    if (target === mouth) return;
    if (target < mouth && v >= MOUTH_UP[mouth - 1] - HYSTERESIS) return;
    if (performance.now() - mouthChangedAt < MOUTH_HOLD_MS) return;
    paintMouth(target);
  };

  const destroy = () => {
    if (!alive) return;
    alive = false;
    for (const key of Object.keys(timers)) clear(key);
    svg.remove();
  };

  scheduleBlink();
  return { setState, setLevel, destroy };
}
