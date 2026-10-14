// ES の読み取り（PDF・画像 → フォームの下書き）。入力の検証と、LLM に渡す一時ファイルの扱い。
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPrompt, esExtractSchema, normalizeExtract } from './review.mjs';

export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_EXTRACT_BODY = 20 * 1024 * 1024; // base64 は元の 4/3 倍。10MB のファイルが入る余裕を見て、それ以上は 413
export class ExtractInputError extends Error {}

const TYPES = {
  'application/pdf': { ext: '.pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/png': { ext: '.png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: '.webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** 本文 { filename, mime, dataBase64 } を検証して { mime, ext, data } を返す。不正なら ExtractInputError。 */
export function validateExtractBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ExtractInputError('本文はオブジェクト');
  const { filename, mime, dataBase64 } = body;
  if (typeof filename !== 'string' || !filename || [...filename].length > 200) throw new ExtractInputError('filename は 1〜200 字の文字列');
  const type = TYPES[mime];
  if (!type) throw new ExtractInputError('読み取れるのは pdf / png / jpg / webp のみ');
  if (typeof dataBase64 !== 'string' || !dataBase64) throw new ExtractInputError('dataBase64 が空');
  if (dataBase64.length > Math.ceil((MAX_FILE * 4) / 3) + 4) throw new ExtractInputError('ファイルは 10MB 以下');
  if (!BASE64.test(dataBase64) || dataBase64.length % 4 !== 0) throw new ExtractInputError('dataBase64 が不正');
  const data = Buffer.from(dataBase64, 'base64');
  if (data.length > MAX_FILE) throw new ExtractInputError('ファイルは 10MB 以下');
  if (!type.magic(data)) throw new ExtractInputError('ファイルの中身が mime と一致しない');
  return { mime, ext: type.ext, data };
}

/** 一時ファイルに書いて LLM に渡し、読み取り結果の下書きを返す（ファイルは必ず消す）。 */
export async function extractEs(input, { llm, plan, onProgress = null }) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-interview-extract-'));
  try {
    const path = join(dir, `es-source${input.ext}`);
    await writeFile(path, input.data);
    const raw = await llm.runStructured({ kind: 'es-extract', plan, prompt: extractPrompt(), schema: esExtractSchema(), files: [path], onProgress });
    return normalizeExtract(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
