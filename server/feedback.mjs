// 感想アンケートの検証と保存（data/feedback/<日時>-<乱数>.json）。逐語録・ES・点数・端末IDは保存しない。
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, writeJson } from './http-util.mjs';
import { FEEDBACK_AREAS, FEEDBACK_MAX_CHARS } from '../web/js/labels.mjs';

export const AREA_IDS = FEEDBACK_AREAS.map((a) => a.id);
export const areaLabel = (id) => FEEDBACK_AREAS.find((a) => a.id === id)?.label ?? id;

function part(v, name) {
  if (v == null) return { picks: [], text: '' };
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${name} の形が不正`);
  const picks = v.picks ?? [];
  if (!Array.isArray(picks) || picks.some((p) => !AREA_IDS.includes(p))) throw new HttpError(400, `${name}.picks が不正`);
  const text = v.text ?? '';
  if (typeof text !== 'string') throw new HttpError(400, `${name}.text は文字列`);
  if ([...text].length > FEEDBACK_MAX_CHARS) throw new HttpError(400, `${name}.text は ${FEEDBACK_MAX_CHARS} 字以内`);
  return { picks: [...new Set(picks)], text: text.trim() };
}

/**
 * 本文を検証し、保存する形を返す（新しいオブジェクト）。
 * 使いやすさ（5段階）と使いやすかった点は常に残す。使いにくかった点は、送るにチェックがあるときだけ残す。
 */
export function parseFeedback(body) {
  const rating = body?.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'rating は 1〜5 の整数');
  const sendToDev = body.sendToDev === true;
  const good = part(body.good, 'good');
  const bad = part(body.bad, 'bad');
  return { rating, sendToDev, good, bad: sendToDev ? bad : { picks: [], text: '' } };
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function saveFeedback(dir, record, now = new Date()) {
  await mkdir(dir, { recursive: true });
  const id = `${stamp(now)}-${randomBytes(3).toString('hex')}`;
  const saved = { id, createdAt: now.toISOString(), ...record };
  await writeJson(join(dir, `${id}.json`), saved);
  return saved;
}
