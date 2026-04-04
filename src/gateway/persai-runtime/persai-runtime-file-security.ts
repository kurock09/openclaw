import path from "node:path";
import { detectMime, normalizeMimeType } from "../../media/mime.js";

export const PERSAI_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const DANGEROUS_FILE_EXTENSIONS = new Set([
  ".app",
  ".appimage",
  ".apk",
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".csh",
  ".dll",
  ".dmg",
  ".exe",
  ".hta",
  ".iso",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".mjs",
  ".msi",
  ".msix",
  ".msixbundle",
  ".pkg",
  ".ps1",
  ".ps1xml",
  ".ps2",
  ".psc1",
  ".psc2",
  ".psd1",
  ".psm1",
  ".py",
  ".rb",
  ".reg",
  ".rpm",
  ".scr",
  ".sh",
  ".svg",
  ".vb",
  ".vbe",
  ".vbs",
  ".ws",
  ".wsf",
]);

const SAFE_MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".avi": "video/x-msvideo",
  ".csv": "text/csv",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const ALLOWED_MIMES = new Set([
  "application/json",
  "application/pdf",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/x-opus+ogg",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
]);

function normalizeExtension(fileName?: string | null): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const ext = path.extname(fileName).toLowerCase();
  return ext || undefined;
}

export async function validatePersaiRuntimeMedia(params: {
  buffer: Buffer;
  mimeType?: string | null;
  fileName?: string | null;
  requireAudio?: boolean;
}): Promise<{ mimeType: string; extension: string | null }> {
  if (params.buffer.length > PERSAI_MAX_MEDIA_BYTES) {
    throw new Error(`Media file too large (max ${String(PERSAI_MAX_MEDIA_BYTES / (1024 * 1024))}MB).`);
  }

  const extension = normalizeExtension(params.fileName);
  if (extension && DANGEROUS_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Blocked dangerous file extension: ${extension}`);
  }

  const detectedMime = normalizeMimeType(
    await detectMime({
      buffer: params.buffer,
      headerMime: params.mimeType ?? undefined,
      filePath: params.fileName ?? undefined,
    }),
  );
  const headerMime = normalizeMimeType(params.mimeType ?? undefined);
  const extensionMime = extension ? SAFE_MIME_BY_EXTENSION[extension] : undefined;
  const effectiveMime = detectedMime ?? extensionMime ?? (headerMime !== "application/octet-stream" ? headerMime : undefined);

  if (!effectiveMime || !ALLOWED_MIMES.has(effectiveMime)) {
    throw new Error("Unsupported or unsafe file type.");
  }
  if (params.requireAudio && !effectiveMime.startsWith("audio/")) {
    throw new Error("Only safe audio files are allowed for transcription.");
  }

  return {
    mimeType: effectiveMime,
    extension: extension ?? null,
  };
}
