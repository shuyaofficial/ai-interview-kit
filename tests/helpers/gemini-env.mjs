// テスト用: GEMINI_ENV_FILE を一時ファイルに向けて fn を実行する。
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** GEMINI_ENV_FILE を一時ファイルに向けて fn を実行する。環境変数は必ず元に戻す。 */
export async function withEnvFile(text, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gem-env-'));
  const file = join(dir, 'gemini.env');
  await writeFile(file, text);
  const prev = process.env.GEMINI_ENV_FILE;
  process.env.GEMINI_ENV_FILE = file;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.GEMINI_ENV_FILE; else process.env.GEMINI_ENV_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}
