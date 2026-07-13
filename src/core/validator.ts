import { parseHlsManifest } from "./hls";
import { inspectStreamAdapter } from "./adapter";
import type { StreamAccessMode, StreamAdapter, StreamCandidate } from "../shared/types";

export const MAX_PROBE_BYTES = 4096;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_VALIDATION_BYTES = 768 * 1024;
export const VALIDATION_FRESH_MS = 5 * 60 * 1000;
export const MIN_COMPLETE_HLS_SECONDS = 10;
const MAX_HLS_MANIFEST_DEPTH = 4;

export interface ValidationResult {
  status: "playable" | "rejected";
  reason: string;
  container?: string;
  variants?: StreamCandidate["variants"];
  durationSeconds?: number;
  accessMode?: StreamAccessMode;
  adapter?: StreamAdapter;
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

async function probe(url: string, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("validation-timeout")), 8000);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Range: `bytes=0-${maximum - 1}` },
      signal: controller.signal
    });
    return await readBounded(response, maximum);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function looksLikeManifest(url: string): boolean {
  try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return false; }
}

export async function validateCandidate(candidate: StreamCandidate, signal?: AbortSignal): Promise<ValidationResult> {
  try {
    if (candidate.kind === "file") {
      const bytes = await probe(candidate.url, MAX_PROBE_BYTES, signal);
      const container = sniffContainer(bytes);
      if (!container || container === "image") return { status: "rejected", reason: container === "image" ? "image-wrapped" : "unknown-media", bytesRead: bytes.length };
      if (container === "fmp4-fragment") return { status: "rejected", reason: "media-fragment", bytesRead: bytes.length };
      return { status: "playable", reason: "standard-media", container, bytesRead: bytes.length, accessMode: "portable" };
    }

    let currentUrl = candidate.url;
    let currentBytes = await probe(currentUrl, MAX_MANIFEST_BYTES, signal);
    let bytesRead = currentBytes.length;
    let current = parseHlsManifest(new TextDecoder().decode(currentBytes), currentUrl);
    let variants: StreamCandidate["variants"] = [];
    for (let depth = 0; depth < MAX_HLS_MANIFEST_DEPTH; depth += 1) {
      if (current.type === "master") {
        if (!current.variants[0]) return { status: "rejected", reason: "empty-master", bytesRead };
        variants = current.variants;
        currentUrl = current.variants[0].url;
        currentBytes = await probe(currentUrl, MAX_MANIFEST_BYTES, signal);
        bytesRead += currentBytes.length;
        current = parseHlsManifest(new TextDecoder().decode(currentBytes), currentUrl);
        continue;
      }
      if (current.firstSegmentUrl && looksLikeManifest(current.firstSegmentUrl)) {
        currentUrl = current.firstSegmentUrl;
        currentBytes = await probe(currentUrl, MAX_MANIFEST_BYTES, signal);
        bytesRead += currentBytes.length;
        current = parseHlsManifest(new TextDecoder().decode(currentBytes), currentUrl);
        continue;
      }
      break;
    }
    const media = current;
    if (!media.firstSegmentUrl) return { status: "rejected", reason: "no-media-segment", bytesRead };
    if (media.type === "master" || looksLikeManifest(media.firstSegmentUrl)) return { status: "rejected", reason: "manifest-depth-limit", bytesRead };
    if (media.endList && (media.durationSeconds || 0) < MIN_COMPLETE_HLS_SECONDS) {
      return { status: "rejected", reason: "short-complete-hls", bytesRead };
    }
    const segment = await probe(media.firstSegmentUrl, MAX_PROBE_BYTES, signal);
    const sniffedContainer = sniffContainer(segment);
    bytesRead += segment.length;
    const adapter = sniffedContainer === "image" ? inspectStreamAdapter(segment) : null;
    if (!sniffedContainer || (sniffedContainer === "image" && !adapter)) return { status: "rejected", reason: sniffedContainer === "image" ? "image-wrapped" : "unknown-media", bytesRead };
    const container = adapter ? "mpeg-ts" : sniffedContainer === "fmp4-fragment" ? "mp4" : sniffedContainer;
    const durationSeconds = media.durationSeconds;
    const estimatedVariants = variants.map((variant) => ({
      ...variant,
      estimatedBytes: durationSeconds && variant.bandwidth ? Math.round((durationSeconds * variant.bandwidth) / 8) : undefined
    }));
    return { status: "playable", reason: adapter ? "portable-adapter-hls" : "portable-hls", container, variants: estimatedVariants, durationSeconds, bytesRead, accessMode: "portable", adapter: adapter?.adapter };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message.slice(0, 80) : "validation-error", bytesRead: 0 };
  }
}

export function validationIsFresh(candidate: StreamCandidate, now = Date.now()): boolean {
  return candidate.validationStatus === "playable" && Boolean(candidate.validatedAt) && now - (candidate.validatedAt || 0) <= VALIDATION_FRESH_MS;
}
