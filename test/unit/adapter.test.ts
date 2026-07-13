import assert from "node:assert/strict";
import test from "node:test";
import { inspectStreamAdapter, transformStreamAdapterPayload, unwrapStreamAdapter } from "../../src/core/adapter";

const pngPrefix = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082", "hex"));

function transportStream(): Uint8Array {
  const output = new Uint8Array(188 * 3);
  output[0] = output[188] = output[376] = 0x47;
  return output;
}

function wrappedSegment(): Uint8Array {
  const stream = transportStream();
  const output = new Uint8Array(pngPrefix.length + stream.length);
  output.set(pngPrefix);
  output.set(stream, pngPrefix.length);
  return output;
}

test("detects and removes a bounded PNG prefix before MPEG-TS", () => {
  const wrapped = wrappedSegment();
  assert.deepEqual(inspectStreamAdapter(wrapped), { adapter: "png-prefix-mpegts", payloadOffset: 70 });
  assert.deepEqual(unwrapStreamAdapter(wrapped, "png-prefix-mpegts"), transportStream());
});

test("accepts bounded zero or ff padding before the MPEG-TS boundary", () => {
  const stream = transportStream();
  const output = new Uint8Array(pngPrefix.length + 137 + stream.length);
  output.set(pngPrefix);
  output.fill(0xff, pngPrefix.length, pngPrefix.length + 137);
  output.set(stream, pngPrefix.length + 137);
  assert.deepEqual(inspectStreamAdapter(output), { adapter: "png-prefix-mpegts", payloadOffset: 207 });
  assert.deepEqual(unwrapStreamAdapter(output, "png-prefix-mpegts"), stream);

  output[pngPrefix.length + 20] = 0x22;
  assert.equal(inspectStreamAdapter(output), null);
});

test("preserves ordinary fragments and rejects image-only or misaligned payloads", () => {
  const stream = transportStream();
  assert.equal(transformStreamAdapterPayload(stream, "png-prefix-mpegts"), stream);
  assert.equal(inspectStreamAdapter(pngPrefix), null);
  const invalid = wrappedSegment();
  invalid[70 + 188] = 0;
  assert.equal(inspectStreamAdapter(invalid), null);
  assert.throws(() => unwrapStreamAdapter(invalid, "png-prefix-mpegts"), /invalid-png-prefix-mpegts/);
});

test("rejects oversized PNG chunk declarations", () => {
  const invalid = wrappedSegment();
  new DataView(invalid.buffer).setUint32(8, 64 * 1024);
  assert.equal(inspectStreamAdapter(invalid), null);
});
