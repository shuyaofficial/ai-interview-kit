// 採点レポートの部品: 総合評価・6軸・次の練習・話し方の目安・逐語録。どれも { scoring: {axes, overall} } 形のデータから描く。
import { h, meterBar, ico, axisScores } from './dom.mjs';
import { state } from './state.mjs';
import { rankFromScores } from '../rank.mjs';

const ROLE_LABEL = { interviewer: '面接官', candidate: '自分' };

function highlightFillers(text) {
  const words = [...state.config.speechGuide.fillers].sort((a, b) => b.length - a.length);
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(h('mark', { class: 'filler', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function renderOverall(scoring) {
  const r = rankFromScores(axisScores(scoring.axes));
  return h('section', { class: 'panel overall', 'aria-labelledby': 'h-overall' },
    h('h3', { id: 'h-overall', text: '総合評価' }),
    r ? h('div', { class: 'rank-block' },
      h('div', { class: 'rank-stamp', role: 'img', 'aria-label': `ランク ${r.rank}` }, h('b', { text: r.rank })),
      h('p', { class: 'points' }, h('b', { text: String(r.points) }), ' / 100'),
      meterBar('bar', r.points),
      h('p', { class: 'small', text: `${scoring.axes.length} 軸の平均 ${r.avg.toFixed(1)} / 5` })) : null,
    h('p', { class: 'summary', text: scoring.overall.summary }));
}

function deltaEl(cur, prev) {
  if (prev == null) return h('span', { class: 'axis-delta' });
  const d = cur - prev;
  if (d > 0) return h('span', { class: 'axis-delta up', text: `↑ +${d}` });
  if (d < 0) return h('span', { class: 'axis-delta down', text: `↓ ${d}` });
  return h('span', { class: 'axis-delta same', text: '— ±0' });
}

export function renderAxes(scoring, prev) {
  const rows = [];
  for (const def of state.session?.noEs ? state.config.axesNoEs : state.config.axes) {
    const a = scoring.axes.find((x) => x.axis === def.id);
    if (!a && scoring.unobserved?.includes(def.id)) { // 1 つの話題だけの練習で、見ていない軸。0 点にせず、平均にも入れない
      rows.push(h('div', { class: 'axis-row not-observed', 'data-axis': def.id },
        h('div', { class: 'axis-head' }, h('span', { class: 'axis-name' }, h('span', { class: 'name', text: def.label })), h('span', { class: 'axis-skip', text: state.config.notObservedText }))));
      continue;
    }
    if (!a) continue;
    const before = prev?.[def.id];
    const detail = h('div', { class: 'axis-detail', id: `ax-${def.id}`, hidden: true },
      h('p', { text: `見るところ: ${def.looksAt}` }),
      h('p', { text: `${a.score}点の基準: ${def.anchors[a.score]}` }),
      h('p', { text: `理由: ${a.reason}` }),
      a.evidence.length ? h('ul', { class: 'plain' }, a.evidence.map((ev) => h('li', { text: `ターン${ev.turn}: 「${ev.quote}」` }))) : null,
      a.evidenceInvalid ? h('p', { class: 'note', text: '注記: この軸の根拠引用は逐語録と一致しませんでした。点数は参考として見てください。' }) : null);
    const info = h('button', { type: 'button', class: 'info', 'aria-expanded': 'false', 'aria-controls': detail.id, 'aria-label': `${def.label}の定義と基準を見る` }, ico('i-info'));
    info.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      info.setAttribute('aria-expanded', String(!detail.hidden));
    });
    rows.push(h('div', { class: 'axis-row', 'data-axis': def.id },
      h('div', { class: 'axis-head' },
        h('span', { class: 'axis-name' }, h('span', { class: 'name', text: def.label }), info),
        h('div', { class: 'bars' },
          meterBar('bar cur', (a.score / 5) * 100),
          before != null ? meterBar('bar prev', (before / 5) * 100) : null),
        h('span', { class: 'axis-score', text: `${a.score} / 5` }),
        deltaEl(a.score, before)),
      detail));
  }
  return h('section', { class: 'panel axes', 'aria-labelledby': 'h-axes' },
    h('div', { class: 'panel-head' },
      h('h3', { id: 'h-axes', text: '評価軸ごとのスコア' }),
      h('span', { class: 'legend' },
        h('span', { class: 'dot cur' }), '今回',
        prev ? [h('span', { class: 'dot prev' }), '前回'] : h('span', { class: 'muted', text: '（前回の記録なし）' }))),
    scoring.unobserved?.length ? h('p', { class: 'small', text: `1つの話題だけの練習なので、見ていない軸は「${state.config.notObservedText}」と表示します。点数は 0 ではなく、総合評価の平均にも入れていません。` }) : null,
    rows);
}

export function renderPractice(scoring) {
  return h('section', { class: 'panel practice', 'aria-labelledby': 'h-practice' },
    h('h3', { id: 'h-practice', text: '次の練習 3 つ' }),
    h('ol', { class: 'practice-list' }, scoring.overall.nextPractice.map((t, i) => h('li', {},
      h('label', {},
        h('span', { class: 'num', text: String(i + 1) }),
        h('span', { class: 'practice-text', text: t }),
        h('input', { type: 'checkbox', 'aria-label': `${i + 1} つ目を練習した` }))))));
}

export function renderSpeech(report) {
  const sp = report.speech;
  const rows = sp.answers.map((a) => h('tr', {},
    h('td', { text: `ターン${a.turn}` }), h('td', { text: String(a.chars) }), h('td', { text: String(a.sec) }),
    h('td', { text: a.charsPerMin == null ? '—' : String(a.charsPerMin) }), h('td', { text: String(a.fillerCount) })));
  const used = Object.entries(sp.fillers.byWord).filter(([, n]) => n > 0).map(([w, n]) => `${w}×${n}`).join('、') || 'なし';
  return h('section', { class: 'panel speech', 'aria-labelledby': 'h-speech' },
    h('h3', { id: 'h-speech', text: '話し方の目安（採点外）' }),
    h('p', { class: 'muted', text: '採点外の目安です。点数には含まれません。' }),
    h('dl', { class: 'facts' },
      h('div', {}, h('dt', { text: '話す速さ' }), h('dd', {}, h('b', { text: String(sp.charsPerMin ?? '—') }), ` 字/分（目安 ${sp.guideCharsPerMin}）`)),
      h('div', {}, h('dt', { text: 'フィラー' }), h('dd', {}, h('b', { text: String(sp.fillers.total) }), ` 回（${used}）`)),
      h('div', {}, h('dt', { text: '最長の沈黙' }), h('dd', {}, h('b', { text: String(sp.longestSilence.sec) }), ' 秒（ターン間）'))),
    h('table', { class: 'metrics' },
      h('thead', {}, h('tr', {}, ['回答', '字数', '秒', '字/分', 'フィラー'].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows)));
}

export function renderTranscript(transcript) {
  return h('section', { class: 'panel transcript', 'aria-labelledby': 'h-transcript' },
    h('h3', { id: 'h-transcript', text: '逐語録' }),
    h('p', { class: 'muted', text: '黄色の下線はフィラー（言いよどみ）です。' }),
    transcript.turns.map((t, i) => h('div', { class: `turn turn-${t.role}` },
      h('span', { class: 'who', text: `${i} ${ROLE_LABEL[t.role]}` }),
      h('span', { class: 'say' }, t.role === 'candidate' ? highlightFillers(t.text) : t.text))));
}

export function renderCompliance(violations) {
  if (!violations.length) return null;
  return h('div', { class: 'warn', role: 'alert' },
    h('p', { text: `面接官の発言に、聞いてはいけない話題の疑いが ${violations.length} 件あります。` }),
    h('ul', { class: 'plain' }, violations.map((v) => h('li', { text: `ターン${v.turn}（${v.topic}）: ${v.quote}` }))));
}
