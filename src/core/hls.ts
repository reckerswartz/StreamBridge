import { stableId } from "./classifier";
import type { StreamVariant } from "../shared/types";

export interface HlsManifestResult {
  type: "master" | "media";
  variants: StreamVariant[];
  firstSegmentUrl?: string;
  durationSeconds?: number;
  endList?: boolean;
}

function absoluteUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[match[1]] = match[2].replace(/^"|"$/g, "");
  return result;
}

export function parseHlsManifest(text: string, manifestUrl: string): HlsManifestResult {
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
      if (!next) continue;
      const url = absoluteUrl(next, manifestUrl);
      if (!url) continue;
      const [width, height] = (attrs.RESOLUTION || "").split("x").map(Number);
      const bandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH) || undefined;
      variants.push({
        id: stableId(url),
        url,
        quality: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : "Variant",
        width: width || undefined,
        height: height || undefined,
        bandwidth
      });
    }
    if (line.startsWith("#EXTINF:")) duration += Number.parseFloat(line.slice(8)) || 0;
    if (!firstSegmentUrl && !line.startsWith("#") && !lines[index - 1]?.startsWith("#EXT-X-STREAM-INF:")) {
      firstSegmentUrl = absoluteUrl(line, manifestUrl) || undefined;
    }
  }

  variants.sort((left, right) => (right.height || 0) - (left.height || 0) || (right.bandwidth || 0) - (left.bandwidth || 0));
  if (variants.length) return { type: "master", variants };
  return { type: "media", variants: [], firstSegmentUrl, durationSeconds: duration || undefined, endList: lines.includes("#EXT-X-ENDLIST") };
}
