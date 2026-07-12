import assert from "node:assert/strict";
import test from "node:test";
import { parseHlsManifest } from "../../src/core/hls";

test("parses and sorts HLS master variants", () => {
  const manifest = parseHlsManifest(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
high/index.m3u8`, "https://cdn.test/master.m3u8");
  assert.equal(manifest.type, "master");
  assert.deepEqual(manifest.variants.map((variant) => variant.quality), ["1080p", "360p"]);
  assert.equal(manifest.variants[0].url, "https://cdn.test/high/index.m3u8");
});

test("parses media duration and first segment", () => {
  const manifest = parseHlsManifest(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
segment-0.ts
#EXTINF:3.5,
segment-1.ts
#EXT-X-ENDLIST`, "https://cdn.test/media/index.m3u8");
  assert.equal(manifest.type, "media");
  assert.equal(manifest.durationSeconds, 7.5);
  assert.equal(manifest.endList, true);
  assert.equal(manifest.firstSegmentUrl, "https://cdn.test/media/segment-0.ts");
});
