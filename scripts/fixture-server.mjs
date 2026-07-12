import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtures = resolve(root, ".tmp/fixtures");
const page = `<!doctype html><html><head><meta charset="utf-8"><title>StreamBridge fixture</title></head><body>
<h1>StreamBridge deterministic fixture</h1>
<button id="play-direct">Play direct media</button><button id="play-webm">Play WebM media</button><button id="request-hls">Request HLS</button>
<div id="player"></div>
<script>
document.querySelector('#play-direct').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.src='/media/sample.mp4?token=fixture-secret';document.querySelector('#player').replaceChildren(v);v.play().catch(()=>{});};
document.querySelector('#play-webm').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.src='/media/sample.webm?token=fixture-secret';document.querySelector('#player').replaceChildren(v);v.play().catch(()=>{});};
document.querySelector('#request-hls').onclick=()=>fetch('/media/master.m3u8?token=fixture-secret').then(r=>r.text());
</script></body></html>`;

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  if (request.url?.startsWith("/fixture")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page);
    return;
  }
  const rawName = request.url?.split("?", 1)[0].replace("/media/", "") || "";
  if (!/^(?:sample\.(?:mp4|webm)|master\.m3u8|media\.m3u8|segment-\d+\.ts)$/.test(rawName)) {
    response.statusCode = 404; response.end("not found"); return;
  }
  const file = resolve(fixtures, rawName);
  const info = await stat(file);
  const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
  if (range) {
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Length", end - start + 1);
  response.setHeader("Content-Type", rawName.endsWith(".mp4") ? "video/mp4" : rawName.endsWith(".webm") ? "video/webm" : rawName.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
  createReadStream(file, { start, end }).pipe(response);
});

server.listen(8765, "127.0.0.1", () => console.log("Fixture server listening on http://127.0.0.1:8765"));
