import assert from "node:assert/strict";
import test from "node:test";
import { sniffContainer, validateCandidate, validationIsFresh } from "../../src/core/validator";
import type { StreamCandidate } from "../../src/shared/types";

test("recognizes portable containers and rejects image signatures", () => {
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), "mp4");
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 24, 0x73, 0x74, 0x79, 0x70])), "fmp4-fragment");
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 24, 0x6d, 0x6f, 0x6f, 0x66])), "fmp4-fragment");
  assert.equal(sniffContainer(Uint8Array.from([0x47, 0, 0, 0])), "mpeg-ts");
  assert.equal(sniffContainer(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), "webm");
  assert.equal(sniffContainer(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image");
});

test("portable validation expires", () => {
  const candidate = { validationStatus: "playable", validatedAt: 1000 } as StreamCandidate;
  assert.equal(validationIsFresh(candidate, 2000), true);
  assert.equal(validationIsFresh(candidate, 10 * 60 * 1000), false);
});

test("follows a bounded HLS manifest indirection before probing media", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/outer.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-VERSION:3\nnested/media.m3u8\n", { status: 206 });
    }
    if (url.endsWith("/nested/media.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment-0.ts\n#EXTINF:6,\nsegment-1.ts\n#EXT-X-ENDLIST\n", { status: 206 });
    }
    if (url.endsWith("/nested/segment-0.ts")) {
      return new Response(Uint8Array.from([0x47, 0, 0, 0]), { status: 206 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await validateCandidate({
      id: "nested",
      tabId: 1,
      frameId: 2,
      playerContext: "embedded",
      sourceDocumentUrl: "https://player.test/embed",
      url: "https://cdn.test/outer.m3u8",
      displayUrl: "cdn.test/outer.m3u8",
      kind: "hls",
      mime: "application/vnd.apple.mpegurl",
      firstSeenAt: Date.now(),
      validationStatus: "checking",
      variants: []
    });
    assert.equal(result.status, "playable");
    assert.equal(result.container, "mpeg-ts");
    assert.equal(result.durationSeconds, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recognizes PNG-prefixed MPEG-TS as a browser-adapter HLS stream", async () => {
  const originalFetch = globalThis.fetch;
  const prefix = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082", "hex");
  const stream = Buffer.alloc(188 * 3);
  stream[0] = stream[188] = stream[376] = 0x47;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/adapter.m3u8")) return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.png\n#EXTINF:6,\nsegment-2.png\n#EXT-X-ENDLIST\n", { status: 206 });
    if (url.endsWith("/segment.png")) return new Response(Buffer.concat([prefix, stream]), { status: 206 });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await validateCandidate({
      id: "adapter",
      tabId: 1,
      frameId: 0,
      playerContext: "top",
      sourceDocumentUrl: "https://player.test/watch",
      url: "https://cdn.test/adapter.m3u8",
      displayUrl: "cdn.test/adapter.m3u8",
      kind: "hls",
      mime: "application/vnd.apple.mpegurl",
      firstSeenAt: Date.now(),
      validationStatus: "checking",
      variants: []
    });
    assert.equal(result.status, "playable");
    assert.equal(result.container, "mpeg-ts");
    assert.equal(result.adapter, "png-prefix-mpegts");
    assert.equal(result.reason, "portable-adapter-hls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
