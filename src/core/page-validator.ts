import type { StreamKind, StreamVariant } from "../shared/types";
import type { ValidationResult } from "./validator";

/**
 * Runs in the page's MAIN world. Keep this function self-contained: browser
 * scripting APIs serialize it instead of loading this module in the page.
 */
export async function validateInPageContext(rawUrl: string, kind: StreamKind): Promise<ValidationResult> {
  const MAX_PROBE_BYTES = 4096;
  const MAX_MANIFEST_BYTES = 512 * 1024;
  const MAX_VALIDATION_BYTES = 768 * 1024;
  const MIN_COMPLETE_HLS_SECONDS = 10;
  const MAX_HLS_MANIFEST_DEPTH = 4;
  const MAX_ADAPTER_PREFIX_BYTES = 64 * 1024;
  const MAX_ADAPTER_PADDING_BYTES = 4 * 1024;
  let bytesRead = 0;

  const stableId = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  const sniffContainer = (bytes: Uint8Array): string | null => {
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
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
    if (bytes.length >= 1 && bytes[0] === 0x47) return "mpeg-ts";
    if (bytes.length >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "ID3") return "audio";
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio";
    if (bytes.length >= 8 && bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG") return "image";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
    return null;
  };

  const adapterPayloadOffset = (bytes: Uint8Array): number | null => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < signature.length || !signature.every((value, index) => bytes[index] === value)) return null;
    let offset = signature.length;
    for (let chunk = 0; chunk < 32 && offset + 12 <= bytes.length && offset <= MAX_ADAPTER_PREFIX_BYTES; chunk += 1) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const end = offset + 12 + length;
      if (end > bytes.length || end > MAX_ADAPTER_PREFIX_BYTES) return null;
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      offset = end;
      if (type !== "IEND") continue;
      if (length !== 0) return null;
      const limit = Math.min(bytes.length - 1, offset + MAX_ADAPTER_PADDING_BYTES);
      for (let payloadOffset = offset; payloadOffset <= limit; payloadOffset += 1) {
        if (bytes[payloadOffset] === 0x47) {
          let comparisons = 0;
          let valid = true;
          for (let packet = 1; packet <= 2; packet += 1) {
            const syncOffset = payloadOffset + packet * 188;
            if (syncOffset >= bytes.length) break;
            comparisons += 1;
            if (bytes[syncOffset] !== 0x47) valid = false;
          }
          if (valid && comparisons) return payloadOffset;
        }
        if (bytes[payloadOffset] !== 0x00 && bytes[payloadOffset] !== 0xff) return null;
      }
      return null;
    }
    return null;
  };

  const readBounded = async (url: string, requestedMaximum: number): Promise<Uint8Array> => {
    const remaining = MAX_VALIDATION_BYTES - bytesRead;
    const maximum = Math.max(0, Math.min(requestedMaximum, remaining));
    if (!maximum) throw new Error("validation-byte-limit");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("validation-timeout")), 8000);
    try {
      const response = await fetch(url, {
        credentials: "omit",
        headers: { Range: `bytes=0-${maximum - 1}` },
        signal: controller.signal
      });
      if (!response.ok && response.status !== 206) throw new Error(`http-${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) {
        const bytes = new Uint8Array((await response.arrayBuffer()).slice(0, maximum));
        bytesRead += bytes.length;
        return bytes;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (total < maximum) {
          const { done, value } = await reader.read();
          if (done) break;
          const slice = value.slice(0, maximum - total);
          chunks.push(slice);
          total += slice.length;
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
      bytesRead += output.length;
      return output;
    } finally {
      clearTimeout(timeout);
    }
  };

  const absoluteUrl = (value: string, baseUrl: string): string | null => {
    try { return new URL(value, baseUrl).href; } catch { return null; }
  };

  const attributes = (line: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[match[1]] = match[2].replace(/^"|"$/g, "");
    return result;
  };

  const parseManifest = (text: string, manifestUrl: string): { type: "master" | "media"; variants: StreamVariant[]; firstSegmentUrl?: string; durationSeconds?: number; endList?: boolean } => {
    if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("not-hls");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants: StreamVariant[] = [];
    let duration = 0;
    let firstSegmentUrl: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = attributes(line.slice(line.indexOf(":") + 1));
        const next = lines.slice(index + 1).find((value) => !value.startsWith("#"));
        const url = next ? absoluteUrl(next, manifestUrl) : null;
        if (url) {
          const [width, height] = (attrs.RESOLUTION || "").split("x").map(Number);
          const bandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH) || undefined;
          variants.push({ id: stableId(url), url, quality: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : "Variant", width: width || undefined, height: height || undefined, bandwidth });
        }
      }
      if (line.startsWith("#EXTINF:")) duration += Number.parseFloat(line.slice(8)) || 0;
      if (!firstSegmentUrl && !line.startsWith("#") && !lines[index - 1]?.startsWith("#EXT-X-STREAM-INF:")) firstSegmentUrl = absoluteUrl(line, manifestUrl) || undefined;
    }
    variants.sort((left, right) => (right.height || 0) - (left.height || 0) || (right.bandwidth || 0) - (left.bandwidth || 0));
    return variants.length
      ? { type: "master", variants }
      : { type: "media", variants: [], firstSegmentUrl, durationSeconds: duration || undefined, endList: lines.includes("#EXT-X-ENDLIST") };
  };

  const looksLikeManifest = (url: string): boolean => {
    try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return false; }
  };

  try {
    if (kind === "file") {
      const bytes = await readBounded(rawUrl, MAX_PROBE_BYTES);
      const container = sniffContainer(bytes);
      if (!container || container === "image") return { status: "rejected", reason: container === "image" ? "image-wrapped" : "unknown-media", bytesRead };
      if (container === "fmp4-fragment") return { status: "rejected", reason: "media-fragment", bytesRead };
      return { status: "playable", reason: "site-context-media", container, bytesRead, accessMode: "site-context" };
    }

    let currentUrl = rawUrl;
    let currentBytes = await readBounded(currentUrl, MAX_MANIFEST_BYTES);
    let current = parseManifest(new TextDecoder().decode(currentBytes), currentUrl);
    let variants: StreamVariant[] = [];
    for (let depth = 0; depth < MAX_HLS_MANIFEST_DEPTH; depth += 1) {
      if (current.type === "master") {
        if (!current.variants[0]) return { status: "rejected", reason: "empty-master", bytesRead };
        variants = current.variants;
        currentUrl = current.variants[0].url;
        currentBytes = await readBounded(currentUrl, MAX_MANIFEST_BYTES);
        current = parseManifest(new TextDecoder().decode(currentBytes), currentUrl);
        continue;
      }
      if (current.firstSegmentUrl && looksLikeManifest(current.firstSegmentUrl)) {
        currentUrl = current.firstSegmentUrl;
        currentBytes = await readBounded(currentUrl, MAX_MANIFEST_BYTES);
        current = parseManifest(new TextDecoder().decode(currentBytes), currentUrl);
        continue;
      }
      break;
    }
    const media = current;
    if (!media.firstSegmentUrl) return { status: "rejected", reason: "no-media-segment", bytesRead };
    if (media.type === "master" || looksLikeManifest(media.firstSegmentUrl)) return { status: "rejected", reason: "manifest-depth-limit", bytesRead };
    if (media.endList && (media.durationSeconds || 0) < MIN_COMPLETE_HLS_SECONDS) return { status: "rejected", reason: "short-complete-hls", bytesRead };
    const segment = await readBounded(media.firstSegmentUrl, MAX_PROBE_BYTES);
    const sniffedContainer = sniffContainer(segment);
    const adapterOffset = sniffedContainer === "image" ? adapterPayloadOffset(segment) : null;
    if (!sniffedContainer || (sniffedContainer === "image" && adapterOffset === null)) return { status: "rejected", reason: sniffedContainer === "image" ? "image-wrapped" : "unknown-media", bytesRead };
    const durationSeconds = media.durationSeconds;
    const estimatedVariants = variants.map((variant) => ({ ...variant, estimatedBytes: durationSeconds && variant.bandwidth ? Math.round((durationSeconds * variant.bandwidth) / 8) : undefined }));
    return { status: "playable", reason: adapterOffset === null ? "site-context-hls" : "site-context-adapter-hls", container: adapterOffset === null ? sniffedContainer === "fmp4-fragment" ? "mp4" : sniffedContainer : "mpeg-ts", variants: estimatedVariants, durationSeconds, bytesRead, accessMode: "site-context", adapter: adapterOffset === null ? undefined : "png-prefix-mpegts" };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message.slice(0, 80) : "validation-error", bytesRead };
  }
}
