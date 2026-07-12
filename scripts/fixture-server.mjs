import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtures = resolve(root, ".tmp/fixtures");
const hlsBundle = resolve(root, "node_modules/hls.js/dist/hls.min.js");
const page = `<!doctype html><html><head><meta charset="utf-8"><title>StreamBridge fixture</title></head><body>
<h1>StreamBridge deterministic fixture</h1>
<button id="play-direct">Play direct media</button><button id="play-webm">Play WebM media</button><button id="request-hls">Request HLS</button>
<div id="player"></div>
<script>
document.querySelector('#play-direct').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.src='/media/sample.mp4?token=fixture-secret';document.querySelector('#player').replaceChildren(v);v.play().catch(()=>{});};
document.querySelector('#play-webm').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.src='/media/sample.webm?token=fixture-secret';document.querySelector('#player').replaceChildren(v);v.play().catch(()=>{});};
document.querySelector('#request-hls').onclick=()=>fetch('/media/master.m3u8?token=fixture-secret').then(r=>r.text());
</script></body></html>`;

const publicSources = [
  ...Array.from({ length: 5 }, (_, index) => ({ kind: "file", url: `https://developer.mozilla.org/shared-assets/videos/flower.mp4?streambridge-stress=${index + 1}` })),
  ...Array.from({ length: 5 }, (_, index) => ({ kind: "file", url: `https://developer.mozilla.org/shared-assets/videos/flower.webm?streambridge-stress=${index + 6}` })),
  ...Array.from({ length: 5 }, (_, index) => ({ kind: "hls", url: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8?streambridge-stress=${index + 11}` }))
];

function stressPage(id, external) {
  const localKind = id <= 5 ? "file" : id <= 10 ? "file" : "hls";
  const localUrl = id <= 5 ? `/media/sample.mp4?stream=${id}` : id <= 10 ? `/media/sample.webm?stream=${id}` : `/media/master.m3u8?stream=${id}`;
  const source = external ? publicSources[id - 1] : { kind: localKind, url: localUrl };
  return `<!doctype html><html><head><meta charset="utf-8"><title>StreamBridge stress ${id}</title></head><body>
<h1>StreamBridge stress stream ${id}</h1><video id="stress-video" controls muted playsinline></video>
<script src="/vendor/hls.min.js"></script><script>
const video=document.querySelector('#stress-video');
const source=${JSON.stringify(source)};
let hls;
async function start(){
  video.muted=true;
  if(source.kind==='hls'&&!video.canPlayType('application/vnd.apple.mpegurl')){
    if(!hls){hls=new Hls({maxBufferLength:8,maxMaxBufferLength:12,backBufferLength:4});hls.loadSource(source.url);hls.attachMedia(video);}
  }else if(!video.src){video.src=source.url;}
  await video.play().catch(()=>undefined);
}
function pause(){video.pause();}
async function capture(){const response=await fetch(source.url,{headers:{Range:'bytes=0-4095'}});await response.body?.cancel().catch(()=>undefined);}
window.streambridgeStress={start,pause,capture,id:${id},sourceKind:source.kind};
if(new URL(location.href).searchParams.get('autoplay')==='1')void start();
if(new URL(location.href).searchParams.get('capture')==='1')void capture();
</script></body></html>`;
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  if (request.url?.startsWith("/fixture")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page);
    return;
  }
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1:8765");
  const stressMatch = requestUrl.pathname.match(/^\/stress\/(control|public)\/(\d+)$/);
  if (stressMatch) {
    const id = Number(stressMatch[2]);
    if (id < 1 || id > 15) { response.statusCode = 404; response.end("not found"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(stressPage(id, stressMatch[1] === "public"));
    return;
  }
  if (requestUrl.pathname === "/vendor/hls.min.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    createReadStream(hlsBundle).pipe(response);
    return;
  }
  const rawName = requestUrl.pathname.replace("/media/", "");
  if (!/^(?:sample\.(?:mp4|webm)|master\.m3u8|media\.m3u8|segment-\d+\.ts)$/.test(rawName)) {
    response.statusCode = 404; response.end("not found"); return;
  }
  const file = resolve(fixtures, rawName);
  if (rawName.endsWith(".m3u8") && requestUrl.searchParams.has("stream")) {
    const stream = requestUrl.searchParams.get("stream");
    let manifest = await readFile(file, "utf8");
    manifest = manifest.replace(/^(media\.m3u8|segment-\d+\.ts)$/gm, `$1?stream=${stream}`);
    response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    response.setHeader("Content-Length", Buffer.byteLength(manifest));
    response.end(manifest);
    return;
  }
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
