import assert from "node:assert/strict";
import test from "node:test";
import { classifyResponse, safeDisplayUrl, stableId } from "../../src/core/classifier";

test("classifies HLS and direct media without exposing signed queries", () => {
  assert.equal(classifyResponse("https://cdn.test/master.m3u8?token=secret")?.kind, "hls");
  assert.equal(classifyResponse("https://cdn.test/video.mp4?token=secret")?.kind, "file");
  assert.equal(safeDisplayUrl("https://cdn.test/video.mp4?token=secret"), "cdn.test/video.mp4");
});

test("suppresses segments and does not infer extensions from query values", () => {
  assert.equal(classifyResponse("https://cdn.test/segment.ts", "video/mp2t"), null);
  assert.equal(classifyResponse("https://cdn.test/video_720p_h264_init_random.mp4", "video/mp4"), null);
  assert.equal(classifyResponse("https://cdn.test/path/init.mp4", "video/mp4"), null);
  assert.equal(classifyResponse("https://cdn.test/api?file=movie.mp4", "application/json"), null);
  assert.equal(classifyResponse("https://cdn.test/chunk-42.mp4", "video/mp4", "xmlhttprequest"), null);
  assert.equal(classifyResponse("https://cdn.test/movie.mp4", "video/mp4", "media")?.kind, "file");
});

test("stable IDs are deterministic", () => {
  assert.equal(stableId("https://example.test/a"), stableId("https://example.test/a"));
  assert.notEqual(stableId("https://example.test/a"), stableId("https://example.test/b"));
});
