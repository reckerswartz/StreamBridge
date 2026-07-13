import assert from "node:assert/strict";
import test from "node:test";
import { createVlcBridgeUrl, createVlcPlaylist, vlcPlaylistFilename } from "../../src/core/vlc";

test("creates a sanitized header-aware VLC playlist", () => {
  const playlist = createVlcPlaylist({
    streamUrl: "https://cdn.test/master.m3u8?token=fixture-secret",
    referrerUrl: "https://video.test/watch/123?private=value",
    userAgent: "Fixture Browser\r\nInjected: no",
    title: "720p\n#EXTVLCOPT:network-caching=999999"
  });
  assert.equal(playlist, [
    "#EXTM3U",
    "#EXTVLCOPT:http-referrer=https://video.test/",
    "#EXTVLCOPT:http-user-agent=Fixture Browser Injected: no",
    "#EXTINF:-1,720p #EXTVLCOPT:network-caching=999999",
    "https://cdn.test/master.m3u8?token=fixture-secret",
    ""
  ].join("\n"));
  assert.equal(playlist.includes("private=value"), false);
  assert.equal(playlist.includes("Cookie:"), false);
  assert.equal(playlist.includes("Authorization:"), false);
});

test("rejects unsupported protocols and URL credentials", () => {
  assert.throws(() => createVlcPlaylist({ streamUrl: "data:text/plain,test", referrerUrl: "https://page.test/", userAgent: "test" }), /HTTP and HTTPS/);
  assert.throws(() => createVlcPlaylist({ streamUrl: "https://user:pass@cdn.test/video.m3u8", referrerUrl: "https://page.test/", userAgent: "test" }), /does not include URL credentials/);
});

test("creates a portable playlist without leaking page context", () => {
  const playlist = createVlcPlaylist({
    streamUrl: "https://cdn.test/video.mp4?token=fixture-secret",
    userAgent: "Fixture Browser",
    title: "Portable MP4"
  });
  assert.equal(playlist.includes("http-referrer"), false);
  assert.equal(playlist.includes("https://cdn.test/video.mp4?token=fixture-secret"), true);
});

test("creates predictable safe playlist filenames", () => {
  assert.equal(vlcPlaylistFilename("1280×720 / High"), "streambridge-1280-720-high.m3u");
  assert.equal(vlcPlaylistFilename("\n\r"), "streambridge-stream.m3u");
});

test("encodes an exact UTF-8 playlist in the Android bridge link", () => {
  const playlist = "#EXTM3U\n#EXTINF:-1,日本語\nhttps://cdn.test/master.m3u8\n";
  const bridge = new URL(createVlcBridgeUrl(playlist));
  assert.equal(bridge.protocol, "streambridge-vlc:");
  assert.equal(bridge.host, "play");
  assert.equal(Buffer.from(bridge.searchParams.get("m3u")!, "base64url").toString("utf8"), playlist);
  assert.throws(() => createVlcBridgeUrl("x".repeat(65_537)), /too large/);
});
