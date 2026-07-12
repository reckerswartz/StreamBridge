import type { StreamKind } from "../shared/types";

const HLS_MIME = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
]);
const FILE_MIME_PREFIXES = ["video/", "audio/"];
const IGNORED_EXTENSIONS = /\.(?:m4s|ts|aac|vtt|srt|jpg|jpeg|png|gif|webp)(?:$|[?#])/i;
const FILE_EXTENSIONS = /\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|oga|ogv)(?:$|[?#])/i;
const HLS_INIT_FRAGMENT = /(?:^|[/_.-])init(?:[/_.-]|$)/i;

export interface ClassifiedResponse {
  kind: StreamKind;
  mime: string;
}

export function classifyResponse(rawUrl: string, contentType = ""): ClassifiedResponse | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (rawUrl.length > 16_384 || IGNORED_EXTENSIONS.test(parsed.pathname) || HLS_INIT_FRAGMENT.test(parsed.pathname)) return null;

  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  if (/\.m3u8?$/i.test(parsed.pathname) || HLS_MIME.has(mime)) return { kind: "hls", mime: mime || "application/vnd.apple.mpegurl" };
  if (FILE_EXTENSIONS.test(parsed.pathname) || FILE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    return { kind: "file", mime: mime || "application/octet-stream" };
  }
  return null;
}

export function safeDisplayUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const path = parsed.pathname.length > 96 ? `…${parsed.pathname.slice(-95)}` : parsed.pathname;
  return `${parsed.host}${path}`;
}

export function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
