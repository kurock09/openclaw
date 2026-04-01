import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { resolvePersaiToolCredentialForEnvVars } from "../../agents/persai-runtime-context.js";

const DEFAULT_YANDEX_TTS_URL =
  "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";

const YANDEX_VOICES = [
  "alena",
  "filipp",
  "ermil",
  "jane",
  "madirus",
  "omazh",
  "zahar",
  "dasha",
  "julia",
  "lera",
  "marina",
  "alexander",
  "kirill",
  "anton",
  "lea",
  "madi",
  "nigora",
  "john",
] as const;

function resolveYandexApiKey(config: {
  yandex?: { apiKey?: string };
}): string | undefined {
  return (
    config.yandex?.apiKey ||
    resolvePersaiToolCredentialForEnvVars({
      envVars: [
        "YANDEX_TTS_API_KEY",
        "YANDEX_SPEECHKIT_API_KEY",
        "YANDEX_API_KEY",
      ],
      provider: "yandex",
      toolName: "tts",
    })?.value ||
    process.env.YANDEX_TTS_API_KEY ||
    process.env.YANDEX_SPEECHKIT_API_KEY ||
    process.env.YANDEX_API_KEY
  );
}

function resolveYandexIamToken(): string | undefined {
  return (
    resolvePersaiToolCredentialForEnvVars({
      envVars: ["YANDEX_IAM_TOKEN"],
      provider: "yandex",
      toolName: "tts",
    })?.value || process.env.YANDEX_IAM_TOKEN
  );
}

function resolveYandexFolderId(config: {
  yandex?: { folderId?: string };
}): string | undefined {
  return (
    config.yandex?.folderId ||
    resolvePersaiToolCredentialForEnvVars({
      envVars: ["YANDEX_FOLDER_ID"],
      provider: "yandex",
      toolName: "tts",
    })?.value ||
    process.env.YANDEX_FOLDER_ID
  );
}

async function yandexTTS(params: {
  text: string;
  apiKey?: string;
  iamToken?: string;
  folderId?: string;
  voice: string;
  lang: string;
  emotion: string;
  speed: number;
  format: "oggopus" | "mp3" | "lpcm";
  sampleRateHertz?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const authHeader = params.iamToken
    ? `Bearer ${params.iamToken}`
    : `Api-Key ${params.apiKey}`;

  if (!params.apiKey && !params.iamToken) {
    throw new Error("Yandex SpeechKit: API key or IAM token required");
  }

  const body = new URLSearchParams();
  body.append("text", params.text);
  body.append("lang", params.lang);
  body.append("voice", params.voice);
  body.append("emotion", params.emotion);
  body.append("speed", String(params.speed));
  body.append("format", params.format);
  if (params.folderId) {
    body.append("folderId", params.folderId);
  }
  if (params.format === "lpcm" && params.sampleRateHertz) {
    body.append("sampleRateHertz", String(params.sampleRateHertz));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(DEFAULT_YANDEX_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Yandex SpeechKit API error (${response.status}): ${errBody.slice(0, 200)}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export function buildYandexSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "yandex",
    label: "Yandex SpeechKit",
    aliases: ["yandex-speechkit", "yandexspeechkit"],
    voices: YANDEX_VOICES,

    listVoices: async () =>
      YANDEX_VOICES.map((v) => ({ id: v, name: v, locale: "ru-RU" })),

    isConfigured: ({ config }) => {
      const yandex = (config as { yandex?: { apiKey?: string } }).yandex;
      return Boolean(
        resolveYandexApiKey({ yandex }) || resolveYandexIamToken(),
      );
    },

    synthesize: async (req) => {
      const yandex = (
        req.config as {
          yandex?: {
            apiKey?: string;
            folderId?: string;
            voice?: string;
            lang?: string;
            emotion?: string;
            speed?: number;
          };
        }
      ).yandex;

      const apiKey = resolveYandexApiKey({ yandex });
      const iamToken = resolveYandexIamToken();
      if (!apiKey && !iamToken) {
        throw new Error("Yandex SpeechKit: API key or IAM token missing");
      }

      const folderId = resolveYandexFolderId({ yandex });
      const format = req.target === "voice-note" ? "oggopus" : "mp3";
      const voice = yandex?.voice || "alena";
      const lang = yandex?.lang || "ru-RU";
      const emotion = yandex?.emotion || "neutral";
      const speed = yandex?.speed ?? 1.0;

      const audioBuffer = await yandexTTS({
        text: req.text,
        apiKey,
        iamToken,
        folderId,
        voice,
        lang,
        emotion,
        speed,
        format,
        timeoutMs: req.config.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: format,
        fileExtension: format === "oggopus" ? ".ogg" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
  };
}
