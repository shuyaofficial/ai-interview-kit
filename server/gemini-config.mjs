// 面接官の声「Gemini 3.8 Live（試験）」のサーバー側: 設定の正本・短期トークンの発行・キーの読み込み。
// 接続方式: ブラウザが Gemini へ WebSocket で直接つなぐ。サーバーはキーで短期トークン（ephemeral token）を1回だけ発行して渡す。
//   キー本体はブラウザへ送らない。面接官プロンプト（システムプロンプト）・モデル・VAD の設定はトークン側で固定する。
//   → 中継（node:http の upgrade）は使わない。音声の往復が1ホップで済み、サーバーが音声を持たない。
// 確認した公式ドキュメント（2026-10-14）:
//   https://ai.google.dev/gemini-api/docs/ephemeral-tokens （Live API 専用・uses・expireTime・newSessionExpireTime・
//     「システムプロンプトをサーバー側に置ける」・v1beta の BidiGenerateContentConstrained?access_token=）
//   https://ai.google.dev/api/live の「Ephemeral authentication tokens」（AuthToken: bidiGenerateContentSetup / fieldMask / uses。
//     fieldMask が空で bidiGenerateContentSetup があれば、接続側の setup は無視され、トークンの setup がそのまま使われる）
//   https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket （ephemeral token の接続先）
//   https://ai.google.dev/gemini-api/docs/live-api/capabilities （realtimeInputConfig.automaticActivityDetection:
//     endOfSpeechSensitivity / silenceDurationMs / prefixPaddingMs。silenceDurationMs は「話し終わりとみなす無音」）
// このファイルは設定と本文の組み立てだけ（キーの読み込み・通信は gemini-live.mjs と Cloudflare の Functions）。

export const GEMINI_MODEL = 'gemini-3.8-live';
export const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
export const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';

/** 応募者の回答の途中で面接官が話し始める割り込み（2026-10-14 の実測: 4回答すべて）を減らす設定。値はここ1か所。 */
export const VAD = {
  endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', // 話し終わりの判定を鈍くする
  silenceDurationMs: 1200,                       // この無音が続くまで話し終わりとみなさない（目安 1000〜1500）
};

export const NEW_SESSION_WINDOW_MS = 60 * 1000;     // 発行から接続を始めるまでの猶予
export const SESSION_MAX_MS = 45 * 60 * 1000;       // 最長の面接（15分）に余裕を足した、トークンで話せる時間

/** 面接官1人ぶんの setup（比較スクリプトと本番トークンで同じもの）。 */
export function buildSetup(prompt) {
  return {
    model: `models/${GEMINI_MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: prompt }] },
    realtimeInputConfig: { automaticActivityDetection: { ...VAD } },
    inputAudioTranscription: { languageCodes: ['ja-JP'] }, // 応募者の字幕に韓国語が混ざったため（AudioTranscriptionConfig.languageCodes）
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} }, // 15分の上限を外す
  };
}

/**
 * トークンで固定する項目（2026-10-14 に実測: fieldMask を渡すと、これらは接続側の setup より優先され、
 * sessionResumption だけ接続側から渡せる。接続は約10分で切れるので、ブラウザは handle を付けて同じトークンでつなぎ直す）。
 */
export const LOCKED_FIELDS = Object.keys(buildSetup(''));


/**
 * トークン発行 API に送る本文。now は ms。キーは本文に入れない（ヘッダ x-goog-api-key で渡す）。
 * sessionMs はトークンで話せる時間（発行からの ms）。省略は SESSION_MAX_MS。面接の種類ごとに短くするときに渡す（サーバーが決める）。
 */
export function tokenRequestBody(prompt, now, { sessionMs = SESSION_MAX_MS } = {}) {
  return {
    uses: 1,
    expireTime: new Date(now + sessionMs).toISOString(),
    newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
    bidiGenerateContentSetup: buildSetup(prompt),
    fieldMask: LOCKED_FIELDS.join(','),
  };
}

export const wsUrl = (token) => `${GEMINI_WS_BASE}?access_token=${encodeURIComponent(token)}`;
