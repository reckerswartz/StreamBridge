import { parseHlsManifest } from "./hls";
import type { StreamCandidate } from "../shared/types";

export const MAX_PROBE_BYTES = 4096;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_VALIDATION_BYTES = 768 * 1024;
export const VALIDATION_FRESH_MS = 5 * 60 * 1000;
export const MIN_COMPLETE_HLS_SECONDS = 10;

export interface ValidationResult {
  status: "playable" | "rejected";
  reason: string;
  container?: string;
  variants?: StreamCandidate["variants"];
  durationSeconds?: number;
  bytesRead: number;
}

function isoBmffContainer(bytes: Uint8Array): "mp4" | "fmp4-fragment" | null {
  const limit = Math.min(bytes.length, 256);
  let offset = 0;
  while (offset + 8 <= limit) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (type === "ftyp") return "mp4";
    if (type === "styp" || type === "moof") return "fmp4-fragment";
    if (size < 8) break;
    offset += size;
  }
  return null;
}

export function sniffContainer(bytes: Uint8Array): string | null {
  const isoBmff = isoBmffContainer(bytes);
  if (isoBmff) return isoBmff;
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (bytes.length >= 1 && bytes[0] === 0x47) return "mpeg-ts";
  if (bytes.length >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "ID3") return "audio";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio";
  if (bytes.length >= 8 && bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG") return "image";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
  return null;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok && response.status !== 206) throw new Error(`http-${response.status}`);
  if (!response.body) return new Uint8Array((await response.arrayBuffer()).slice(0, maximum));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maximum) {
      const { done, value } = await reader.read();
      if (done) break;
      const slice = value.slice(0, maximum - total);
      chunks.push(slice);
      total += slice.length;
      if (total >= maximum) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function probe(url: string, maximum: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { Range: `bytes=0-${maximum - 1}` },
    signal: AbortSignal.timeout(8000)
  });
  return readBounded(response, maximum);
}

export async function validateCandidate(candidate: StreamCandidate): Promise<ValidationResult> {
  try {
    if (candidate.kind === "file") {
      const bytes = await probe(candidate.url, MAX_PROBE_BYTES);
      const container = sniffContainer(bytes);
      if (!container || container === "image") return { status: "rejected", reason: container === "image" ? "image-wrapped" : "unknown-media", bytesRead: bytes.length };
      if (container === "fmp4-fragment") return { status: "rejected", reason: "media-fragment", bytesRead: bytes.length };
      return { status: "playable", reason: "standard-media", container, bytesRead: bytes.length };
    }

    const manifestBytes = await probe(candidate.url, MAX_MANIFEST_BYTES);
    const manifestText = new TextDecoder().decode(manifestBytes);
    const manifest = parseHlsManifest(manifestText, candidate.url);
    const mediaUrl = manifest.type === "master" ? manifest.variants[0]?.url : candidate.url;
    if (!mediaUrl) return { status: "rejected", reason: "empty-master", bytesRead: manifestBytes.length };
    const mediaBytes = manifest.type === "master" ? await probe(mediaUrl, MAX_MANIFEST_BYTES) : manifestBytes;
    const media = parseHlsManifest(new TextDecoder().decode(mediaBytes), mediaUrl);
    if (!media.firstSegmentUrl) return { status: "rejected", reason: "no-media-segment", bytesRead: manifestBytes.length + mediaBytes.length };
    if (media.endList && (media.durationSeconds || 0) < MIN_COMPLETE_HLS_SECONDS) {
      return { status: "rejected", reason: "short-complete-hls", bytesRead: manifestBytes.length + mediaBytes.length };
    }
    const segment = await probe(media.firstSegmentUrl, MAX_PROBE_BYTES);
    const sniffedContainer = sniffContainer(segment);
    if (!sniffedContainer || sniffedContainer === "image") return { status: "rejected", reason: sniffedContainer === "image" ? "image-wrapped" : "unknown-media", bytesRead: manifestBytes.length + mediaBytes.length + segment.length };
    const container = sniffedContainer === "fmp4-fragment" ? "mp4" : sniffedContainer;
    const durationSeconds = media.durationSeconds;
    const variants = manifest.variants.map((variant) => ({
      ...variant,
      estimatedBytes: durationSeconds && variant.bandwidth ? Math.round((durationSeconds * variant.bandwidth) / 8) : undefined
    }));
    return { status: "playable", reason: "portable-hls", container, variants, durationSeconds, bytesRead: manifestBytes.length + mediaBytes.length + segment.length };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message.slice(0, 80) : "validation-error", bytesRead: 0 };
  }
}

export function validationIsFresh(candidate: StreamCandidate, now = Date.now()): boolean {
  return candidate.validationStatus === "playable" && Boolean(candidate.validatedAt) && now - (candidate.validatedAt || 0) <= VALIDATION_FRESH_MS;
}
