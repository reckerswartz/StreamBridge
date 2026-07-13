import type { StreamAdapter } from "../shared/types";

export const MAX_ADAPTER_PREFIX_BYTES = 64 * 1024;
export const MAX_ADAPTER_PADDING_BYTES = 4 * 1024;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MPEG_TS_PACKET_BYTES = 188;

export interface AdapterInspection {
  adapter: StreamAdapter;
  payloadOffset: number;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
}

function hasMpegTsSync(bytes: Uint8Array, offset: number): boolean {
  if (bytes[offset] !== 0x47) return false;
  let comparisons = 0;
  for (let packet = 1; packet <= 2; packet += 1) {
    const syncOffset = offset + packet * MPEG_TS_PACKET_BYTES;
    if (syncOffset >= bytes.length) break;
    comparisons += 1;
    if (bytes[syncOffset] !== 0x47) return false;
  }
  return comparisons > 0;
}

function mpegTsPayloadOffset(bytes: Uint8Array, pngEnd: number): number | null {
  const limit = Math.min(bytes.length - 1, pngEnd + MAX_ADAPTER_PADDING_BYTES);
  for (let offset = pngEnd; offset <= limit; offset += 1) {
    if (bytes[offset] === 0x47 && hasMpegTsSync(bytes, offset)) return offset;
    if (bytes[offset] !== 0x00 && bytes[offset] !== 0xff) return null;
  }
  return null;
}

export function inspectStreamAdapter(bytes: Uint8Array): AdapterInspection | null {
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;
  let offset = PNG_SIGNATURE.length;
  for (let chunk = 0; chunk < 32 && offset + 12 <= bytes.length && offset <= MAX_ADAPTER_PREFIX_BYTES; chunk += 1) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + length;
    if (end > bytes.length || end > MAX_ADAPTER_PREFIX_BYTES) return null;
    const type = chunkType(bytes, offset);
    offset = end;
    if (type !== "IEND") continue;
    if (length !== 0) return null;
    const payloadOffset = mpegTsPayloadOffset(bytes, offset);
    return payloadOffset === null ? null : { adapter: "png-prefix-mpegts", payloadOffset };
  }
  return null;
}

export function unwrapStreamAdapter(bytes: Uint8Array, adapter: StreamAdapter): Uint8Array {
  if (adapter !== "png-prefix-mpegts") throw new Error("unsupported-stream-adapter");
  const inspection = inspectStreamAdapter(bytes);
  if (!inspection || inspection.adapter !== adapter) throw new Error("invalid-png-prefix-mpegts");
  return bytes.slice(inspection.payloadOffset);
}

export function transformStreamAdapterPayload(bytes: Uint8Array, adapter: StreamAdapter): Uint8Array {
  if (!startsWith(bytes, PNG_SIGNATURE)) return bytes;
  return unwrapStreamAdapter(bytes, adapter);
}
