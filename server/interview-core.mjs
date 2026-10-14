// 面接官プロンプトの組み立てと、realtime の通知から逐語録を作るレコーダ（純関数だけ。ファイルを読まない）。
// Node のサーバーは interview.mjs 経由で、Cloudflare の Functions とブラウザはこのファイルを直接読む。テンプレートは引数で渡す。
import { FORBIDDEN_TOPICS } from './rubric.mjs';
import { itemsText, hasEs } from './es.mjs';

/** {{name}} を一度だけ置換する。置換後の本文に {{ があっても再置換しない。 */
export function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

/** 面接の種類ごとの既定値。質問データ側に同じキーがあればそちらが勝つ（一次は question-bank.json に無いのでここが正本）。 */
export const MODE_DEFAULTS = {
  first: {
    label: '一次面接',
    purpose: '話の分かりやすさと人柄、ES との整合から、仕事で何ができるか・どう考えているかを確かめる。',
    durationMin: 15,
    focus: ['話の分かりやすさ（結論から話せるか）', '人柄と関わり方', 'ES との整合'],
  },
  second: { label: '二次面接', purpose: '経験の再現性と仕事で活かせる力を確かめる。', durationMin: 15, focus: [] },
  final: { label: '最終面接', purpose: '入社意思と将来像、一貫性を確かめる。', durationMin: 15, focus: [] },
  midcareer: { label: '中途面接', purpose: '即戦力性と転職理由、定着性を確かめる。', durationMin: 15, focus: [] },
};

const MODE_NOTES = {
  final: '- 「確認」の段階では、入社意思や覚悟を確かめてよい。ただし答えにくい質問でも、仕事への適性・意欲に関わる正当な範囲に限る。下の「絶対に聞いてはいけないこと」は最終面接でもそのまま守る。',
};


/**
 * 質問データの生の JSON を、面接の種類の既定値で補った形にする。段階が無い・種類が不明なら null。
 * ファイルの読み込み（interview.mjs の loadModeBank）と、ビルド済みの質問データ（cloud）が共有する。
 */
export function shapeBank(mode, raw) {
  if (!raw || !Array.isArray(raw.stages) || !raw.stages.length || !MODE_DEFAULTS[mode]) return null;
  const d = MODE_DEFAULTS[mode];
  return {
    ...raw,
    mode,
    label: raw.label || d.label,
    purpose: raw.purpose || d.purpose,
    durationMin: raw.durationMin || d.durationMin,
    focus: raw.focus?.length ? raw.focus : d.focus,
  };
}

/** 画面に出す面接の種類の一覧。bankOf(id) が null の種類は available:false。 */
export function describeModes(bankOf) {
  return Object.keys(MODE_DEFAULTS).map((id) => {
    const bank = bankOf(id);
    const d = MODE_DEFAULTS[id];
    return {
      id,
      label: bank?.label ?? d.label,
      purpose: bank?.purpose ?? d.purpose,
      purposeNoEs: stripEs(bank?.purpose ?? d.purpose),
      durationMin: bank?.durationMin ?? d.durationMin,
      available: Boolean(bank),
      stages: bank ? bank.stages.map((s) => ({ id: s.id, label: s.label, timeboxSec: s.timeboxSec })) : [],
    };
  });
}

export function forbiddenText() {
  return FORBIDDEN_TOPICS.map((t) => `- ${t.label}`).join('\n');
}

const fmtMin = (sec) => String(Math.round((sec / 60) * 10) / 10);

export function stagesText(bank) {
  return bank.stages
    .map((s) => `- ${s.label}（目安${fmtMin(s.timeboxSec)}分）: ${s.questions[0].text}`)
    .join('\n');
}

/** ES が無い面接の「深掘りする論点」。ES の記述に頼らない一般的なもの。 */
export const GENERAL_FOCUS = [
  '自己紹介で出た経験のうち、本人が一番力を入れたものを選び、「そのとき自分は具体的に何をしましたか」と聞く',
  '数字・人数・期間が出てこない話は、規模を聞く',
  '結果だけの話は過程を、強みだけの話は根拠の場面を聞く',
  '「他の選択肢は考えましたか」「次に同じ場面ならどうしますか」で、考え方を確かめる',
  '前に話したことと食い違いがあれば、事実だけを指して確認する',
];

export function focusPointsText(plan, es = null) {
  if (es && !hasEs(es)) return GENERAL_FOCUS.map((t) => `- ${t}`).join('\n');
  const points = plan?.focusPoints;
  if (!Array.isArray(points) || points.length === 0) return '（特になし。ES の記述から自然に深掘りしてください）';
  return points
    .map((p) => {
      const probes = (p.probes ?? []).map((q) => `  - ${q}`).join('\n');
      return `- ${p.topic}（${p.why}）${probes ? `\n${probes}` : ''}`;
    })
    .join('\n');
}

export const stripEs = (text) => String(text ?? '').replace(/ES\s*との(一貫性|整合)(（[^）]*）)?/g, '回答どうしの$1');

/** ES が無い面接用の質問データ。ES に触れる目的・重心を書き換え、質問は textNoEs があればそちらにする。新しいオブジェクトを返す。 */
export function adaptBank(bank, es) {
  if (hasEs(es)) return bank;
  return {
    ...bank,
    purpose: stripEs(bank.purpose),
    focus: (bank.focus ?? []).map(stripEs),
    stages: bank.stages.map((st) => ({ ...st, questions: st.questions.map((q) => (q.textNoEs ? { ...q, text: q.textNoEs } : q)) })),
  };
}

const unset = (v) => (String(v ?? '').trim() ? String(v).trim() : '');

/** 「あなたは ◯◯ の」に入る応募先。会社名が空でも文になる。 */
export function employerText(es) {
  const [c, i] = [unset(es.company), unset(es.industry)];
  if (c) return i ? `${c}（${i}）` : c;
  return i ? `${i}業界の企業（社名は未定）` : '志望先が未定の企業';
}

export const roleLine = (es) => (unset(es.role) ? `応募職種は ${unset(es.role)} です。` : '応募職種は未定です。');

/** 会社名が空のときだけ入る、志望動機の段の指示（先頭に改行を含む。空のときは空文字）。 */
export function companyNote(es) {
  if (unset(es.company)) return '';
  return '\n- 会社名が未指定です。志望動機の段では、最初に「志望している業界と会社はどこですか」と聞き、その答えを前提に、なぜその会社・その業界なのかと志望度を確かめる。';
}

export const PAST_RULE = {
  newgrad: '高校以前の話をした → 「大学に入ってからの経験ではいかがですか」と直近の経験を聞く。',
  midcareer: '数年前の話が中心だった → 「直近の職場での経験ではいかがですか」と直近の経験を聞く。',
};

/** 純関数。bank は loadModeBank の戻り値（生の一次 bank でも、一次の既定値で補って動く）。template の既定は interviewer.md。 */
export function buildInterviewerPrompt(es, plan, rawBank, template) {
  const bank = adaptBank(rawBank, es);
  const noEs = !hasEs(es);
  const mode = bank.mode ?? es.mode ?? 'first';
  const d = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.first;
  const focus = (bank.focus?.length ? bank.focus : d.focus).map((f) => (noEs ? stripEs(f) : f));
  const kind = mode === 'midcareer' ? 'midcareer' : 'newgrad';
  const totalSec = bank.stages.reduce((sum, s) => sum + s.timeboxSec, 0);
  return fillTemplate(template, {
    company: es.company,
    industry: es.industry,
    role: es.role,
    hiringKind: kind === 'midcareer' ? '中途' : '新卒',
    modeLabel: bank.label || d.label,
    purpose: noEs ? stripEs(bank.purpose || d.purpose) : bank.purpose || d.purpose,
    focus: focus.map((f) => `  - ${f}`).join('\n'),
    modeNote: MODE_NOTES[mode] ?? '',
    pastRule: PAST_RULE[kind],
    totalMin: Math.round(totalSec / 60),
    stages: stagesText(bank),
    forbidden: forbiddenText(),
    esItems: itemsText(es),
    focusHeading: noEs ? '深掘りする論点（一般的な論点）' : 'このESで深掘りする論点',
    focusPoints: focusPointsText(plan, es),
    employer: employerText(es),
    roleLine: roleLine(es),
    companyNote: companyNote(es),
  });
}

/** 面接官は応募者の発話を待つため、接続直後にこちらから開始を合図する文（Codex・Gemini 共通）。 */
export const KICKOFF_TEXT = '（応募者が入室し、着席しました。挨拶をして、1分程度の自己紹介をお願いしてください。）';

const ROLE_MAP = { user: 'candidate', assistant: 'interviewer' };

/**
 * thread/realtime/transcript/{delta,done} から逐語録 turns を作る。
 * startMs は最初の delta 受信時刻、endMs は done 受信時刻（レコーダ生成からの相対 ms）。
 * handle() は字幕用イベント {type:'caption', role, text, final} を返す（対象外の通知は null）。
 */
export function createRecorder({ now = Date.now, onTurn = null } = {}) {
  let t0 = now();
  const turns = [];
  const partial = new Map(); // realtime role -> { startMs, text }

  const handle = (method, params) => {
    const role = ROLE_MAP[params?.role];
    if (!role) return null;
    const t = now() - t0;
    if (method === 'thread/realtime/transcript/delta') {
      const cur = partial.get(params.role) ?? { startMs: t, text: '' };
      const next = { startMs: cur.startMs, text: cur.text + (params.delta ?? '') };
      partial.set(params.role, next);
      return { type: 'caption', role, text: next.text, final: false };
    }
    if (method === 'thread/realtime/transcript/done') {
      const cur = partial.get(params.role);
      partial.delete(params.role);
      const text = String(params.text ?? cur?.text ?? '').trim();
      if (!text) return null;
      const startMs = Math.min(cur?.startMs ?? Math.max(0, t - 1), t - 1);
      const turn = { role, text, startMs: Math.max(0, startMs), endMs: Math.max(t, startMs + 1) };
      turns.push(turn);
      onTurn?.({ ...turn });
      return { type: 'caption', role, text, final: true };
    }
    return null;
  };

  /** done が来なかった途中の発言も含め、開始時刻順の turns を返す。 */
  const finish = () => {
    const t = now() - t0;
    const rest = [...partial.entries()]
      .filter(([, p]) => p.text.trim())
      .map(([realtimeRole, p]) => ({
        role: ROLE_MAP[realtimeRole], text: p.text.trim(), startMs: p.startMs, endMs: Math.max(t, p.startMs + 1),
      }));
    return [...turns, ...rest].sort((a, b) => a.startMs - b.startMs).map((x) => ({ ...x }));
  };

  /** 接続が確立した時刻を 0 ms とし直す（それまでに溜めた発言は無い前提）。 */
  const start = () => { t0 = now(); };

  return { handle, finish, start, turnCount: () => turns.length };
}
