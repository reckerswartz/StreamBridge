import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtures = resolve(root, ".tmp/fixtures");
const hlsBundle = resolve(root, "node_modules/hls.js/dist/hls.min.js");
const safeDemo = (await readFile(resolve(root, "docs/demo.html"), "utf8")).replace(/^---\nlayout: null\n---\n/, "");
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamBridge demo</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 80% 10%,#402b82 0,transparent 32%),#151126;color:#fff;font:16px system-ui,sans-serif}.shell{width:min(1060px,calc(100% - 48px));margin:0 auto;padding:68px 0}.eyebrow{color:#aa9bfa;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center}h1{font-size:56px;line-height:1.03;margin:14px 0 20px;max-width:680px}.lead{font-size:20px;line-height:1.6;color:#d2ccea;max-width:620px}.actions{display:flex;gap:12px;margin-top:28px}button{border:1px solid #6d5ac7;border-radius:12px;padding:13px 18px;background:#2c2350;color:#fff;font-weight:700;cursor:pointer}button:first-child{background:#673ee8}.screen{min-height:330px;border:1px solid #5c4d91;border-radius:24px;background:linear-gradient(145deg,#27213e,#19152c);box-shadow:0 30px 80px #090711;padding:22px}.screen p{color:#a9a0c7}.legal{margin-top:50px;color:#81789f;font-size:13px}@media(max-width:760px){.hero{grid-template-columns:1fr}h1{font-size:42px}}
</style></head><body><main class="shell"><div class="hero"><section><div class="eyebrow">Private, local stream detection</div><h1>Open verified media in the player you choose.</h1><p class="lead">StreamBridge detects HLS and direct media after playback starts, validates portability without credentials, and keeps results in session memory.</p><div class="actions">
<button id="play-direct">Play direct media</button><button id="play-webm">Play WebM</button><button id="request-hls">Detect HLS qualities</button></div></section><section class="screen"><strong>Deterministic media demo</strong><p>Start a sample to reveal the StreamBridge controls.</p><div id="player"></div></section></div><p class="legal">Test fixture uses generated media. No browsing data leaves the device except credential-free requests to the selected media origin.</p></main>
<script src="/vendor/hls.min.js"></script><script>
document.querySelector('#play-direct').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.style='display:block;width:640px;max-width:100%;aspect-ratio:16/9';v.src='/media/sample.mp4?token=fixture-secret';document.querySelector('#player').replaceChildren(v);v.play().catch(()=>{});};
document.querySelector('#play-webm').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.style='display:block;width:640px;max-width:100%;aspect-ratio:16/9';v.src='/media/sample.webm?token=fixture-secret';document.querySelector('#player').replaceChildren(v);v.play().catch(()=>{});};
document.querySelector('#request-hls').onclick=()=>{const v=document.createElement('video');v.id='fixture-video';v.controls=true;v.muted=true;v.playsInline=true;v.style='display:block;width:640px;max-width:100%;aspect-ratio:16/9';document.querySelector('#player').replaceChildren(v);const hls=new Hls({maxBufferLength:8,maxMaxBufferLength:12,backBufferLength:4});hls.loadSource('/media/master.m3u8?token=fixture-secret');hls.attachMedia(v);hls.on(Hls.Events.MANIFEST_PARSED,()=>v.play().catch(()=>{}));};
</script></body></html>`;

const contextPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamBridge site-context demo</title></head><body>
<main><h1>Referrer-dependent stream fixture</h1><p>The media origin accepts credential-free requests only when they retain this page context.</p>
<button id="start-context">Start site-context stream</button><video id="context-video" controls muted playsinline style="display:block;width:640px;max-width:100%;margin-top:20px"></video></main>
<script>
document.querySelector('#start-context').onclick=async()=>{
  const video=document.querySelector('#context-video');
  if(!video.src)video.src='/media/sample.mp4?fixture=context-player';
  await video.play().catch(()=>undefined);
  const response=await fetch('http://localhost:8765/context-media/master.m3u8?token=context-fixture',{credentials:'omit',headers:{Range:'bytes=0-4095'}});
  if(!response.ok)throw new Error('context stream unavailable');
  await response.text();
};
</script></body></html>`;

const pageConfigPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamBridge page-config fallback</title></head><body>
<main><h1>Player configuration fallback fixture</h1><button id="start-config">Start configured stream</button>
<video id="config-video" controls muted playsinline style="display:block;width:640px;height:360px;max-width:100%;margin-top:20px"></video></main>
<script>
globalThis.videoPlayerConfig={mediaDefinitions:[{format:'hls',quality:'720',defaultQuality:true,videoUrl:'http://localhost:8765/context-media/master.m3u8?config=worker-fixture'}]};
document.querySelector('#start-config').onclick=async()=>{
  const video=document.querySelector('#config-video');
  video.src='/media/sample.mp4?pre-roll=fixture';
  await video.play().catch(()=>undefined);
  setTimeout(async()=>{video.src='/media/sample.webm?main=fixture';await video.play().catch(()=>undefined);},1500);
};
</script></body></html>`;

const embeddedPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamBridge embedded player demo</title></head><body>
<main><h1>Cross-origin embedded player fixture</h1>
<iframe id="embedded-player" title="Embedded player" src="http://localhost:8765/fixture/embedded-player" style="display:block;width:394px;height:222px;max-width:100%;border:0"></iframe>
<iframe id="autoplay-ad" title="Autoplay advertisement fixture" src="http://localhost:8765/fixture/embedded-ad" style="display:block;width:300px;height:169px;border:0;margin-top:24px"></iframe>
</main></body></html>`;

const embeddedPlayerPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded HLS player</title></head><body style="margin:0;background:#111">
<button id="embedded-play" style="position:absolute;z-index:2;inset:80px auto auto 145px">Play</button>
<video id="embedded-video" controls muted playsinline style="display:block;width:394px;height:222px;max-width:100%"></video>
<script src="/vendor/hls.min.js"></script><script>
const video=document.querySelector('#embedded-video');
const hls=new Hls({autoStartLoad:true,maxBufferLength:8,maxMaxBufferLength:12,backBufferLength:4});
hls.loadSource('/media/master.m3u8?embedded=main');
hls.attachMedia(video);
document.querySelector('#embedded-play').onclick=async()=>{
  document.querySelector('#embedded-play').remove();
  hls.loadSource('/media/master.m3u8?embedded=main');
  await video.play().catch(()=>undefined);
};
</script></body></html>`;

const embeddedAdPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autoplay ad fixture</title></head><body style="margin:0;background:#311">
<video id="ad-video" muted playsinline style="display:block;width:300px;height:169px"></video>
<script src="/vendor/hls.min.js"></script><script>
const video=document.querySelector('#ad-video');
const hls=new Hls({maxBufferLength:4,maxMaxBufferLength:6,backBufferLength:2});
hls.loadSource('/media/master.m3u8?embedded=ad');
hls.attachMedia(video);
void video.play().catch(()=>undefined);
</script></body></html>`;

const adapterPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamBridge adapter fixture</title></head><body style="margin:0;background:#111;color:#fff;font:16px system-ui">
<main><h1>PNG-prefixed MPEG-TS fixture</h1><button id="adapter-play">Play transformed HLS</button><video id="adapter-video" controls muted playsinline style="display:block;width:640px;max-width:100%;aspect-ratio:16/9;margin-top:16px"></video></main>
<script>
const video=document.querySelector('#adapter-video');
void fetch('/adapter-media/master.m3u8?adapter=fixture').then(response=>response.text());
document.querySelector('#adapter-play').onclick=async()=>{video.src='/media/sample.mp4?adapter=site-decoder';await video.play().catch(()=>undefined);};
</script></body></html>`;

const adapterMaster = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
media.m3u8
`;
const pngPrefix = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082", "hex");

const contextMaster = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480
480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720.m3u8
`;

const vlcTarget = "http://127.0.0.1:8765/context-media/master.m3u8?vlc=1";
const vlcReferrer = "http://127.0.0.1:8765/";
const vlcWrappers = new Map([
  ["/vlc-wrapper.m3u", {
    type: "application/x-mpegURL",
    body: `#EXTM3U
#EXTINF:-1,StreamBridge VLC fixture
#EXTVLCOPT:http-referrer=${vlcReferrer}
#EXTVLCOPT:http-user-agent=StreamBridge-VLC-Test/1.0
${vlcTarget}
`
  }],
  ["/vlc-wrapper-options-first.m3u", {
    type: "application/x-mpegURL",
    body: `#EXTM3U
#EXTVLCOPT:http-referrer=${vlcReferrer}
#EXTVLCOPT:http-user-agent=StreamBridge-VLC-Test/1.0
#EXTINF:-1,StreamBridge VLC fixture
${vlcTarget}
`
  }],
  ["/vlc-wrapper.xspf", {
    type: "application/xspf+xml",
    body: `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/" xmlns:vlc="http://www.videolan.org/vlc/playlist/ns/0/">
  <trackList><track><title>StreamBridge VLC fixture</title><location>${vlcTarget.replaceAll("&", "&amp;")}</location>
    <extension application="http://www.videolan.org/vlc/playlist/0">
      <vlc:option>http-referrer=${vlcReferrer}</vlc:option>
      <vlc:option>http-user-agent=StreamBridge-VLC-Test/1.0</vlc:option>
    </extension>
  </track></trackList>
</playlist>
`
  }],
  ["/vlc-wrapper-exthttp.m3u", {
    type: "application/x-mpegURL",
    body: `#EXTM3U
#EXTINF:-1,StreamBridge VLC fixture
#EXTHTTP:{"Referer":"${vlcReferrer}","User-Agent":"StreamBridge-VLC-Test/1.0"}
${vlcTarget}
`
  }],
  ["/vlc-wrapper-pipe.m3u", {
    type: "application/x-mpegURL",
    body: `#EXTM3U
#EXTINF:-1,StreamBridge VLC fixture
${vlcTarget}|Referer=${encodeURIComponent(vlcReferrer)}&User-Agent=${encodeURIComponent("StreamBridge-VLC-Test/1.0")}
`
  }]
]);

const publicSources = [
  ...Array.from({ length: 5 }, (_, index) => ({ kind: "file", url: `https://developer.mozilla.org/shared-assets/videos/flower.mp4?streambridge-stress=${index + 1}` })),
  ...Array.from({ length: 5 }, (_, index) => ({ kind: "file", url: `https://developer.mozilla.org/shared-assets/videos/flower.webm?streambridge-stress=${index + 6}` })),
  ...Array.from({ length: 5 }, (_, index) => ({ kind: "hls", url: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8?streambridge-stress=${index + 11}` }))
];
const requestDiagnostics = [];

function rememberFixtureRequest(request, path, status) {
  requestDiagnostics.push({
    path,
    status,
    origin: request.headers.origin || "",
    referer: request.headers.referer || "",
    userAgent: request.headers["user-agent"] || ""
  });
  if (requestDiagnostics.length > 100) requestDiagnostics.shift();
}

function stressPage(id, external) {
  const localKind = id <= 5 ? "file" : id <= 10 ? "file" : "hls";
  const localUrl = id <= 5 ? `/media/sample.mp4?stream=${id}` : id <= 10 ? `/media/sample.webm?stream=${id}` : `/media/master.m3u8?stream=${id}`;
  const source = external ? publicSources[id - 1] : { kind: localKind, url: localUrl };
  return `<!doctype html><html><head><meta charset="utf-8"><title>StreamBridge stress ${id}</title></head><body>
<h1>StreamBridge stress stream ${id}</h1><video id="stress-video" controls muted playsinline style="display:block;width:394px;height:222px;max-width:100%"></video>
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
if(new URL(location.href).searchParams.get('activate')==='1')document.addEventListener('click',()=>void start(),{once:true});
if(new URL(location.href).searchParams.get('autoplay')==='1')void start();
if(new URL(location.href).searchParams.get('capture')==='1')void capture();
</script></body></html>`;
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  if (request.url?.startsWith("/demo")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(safeDemo);
    return;
  }
  if (request.url?.startsWith("/fixture/embedded-player")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(embeddedPlayerPage);
    return;
  }
  if (request.url?.startsWith("/fixture/embedded-ad")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(embeddedAdPage);
    return;
  }
  if (request.url?.startsWith("/fixture/embedded")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(embeddedPage);
    return;
  }
  if (request.url?.startsWith("/fixture/adapter")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(adapterPage);
    return;
  }
  if (request.url?.startsWith("/fixture/context")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(contextPage);
    return;
  }
  if (request.url?.startsWith("/fixture/page-config")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(pageConfigPage);
    return;
  }
  if (request.url?.startsWith("/fixture")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page);
    return;
  }
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1:8765");
  if (requestUrl.pathname === "/adapter-media/master.m3u8") {
    response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    response.setHeader("Content-Length", Buffer.byteLength(adapterMaster));
    response.end(adapterMaster);
    return;
  }
  if (requestUrl.pathname === "/adapter-media/media.m3u8") {
    let manifest = await readFile(resolve(fixtures, "media.m3u8"), "utf8");
    manifest = manifest.replace(/segment-(\d+)\.ts/g, "segment-$1.png");
    response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    response.setHeader("Content-Length", Buffer.byteLength(manifest));
    response.end(manifest);
    return;
  }
  const adapterSegment = requestUrl.pathname.match(/^\/adapter-media\/segment-(\d+)\.png$/);
  if (adapterSegment) {
    const media = await readFile(resolve(fixtures, `segment-${adapterSegment[1]}.ts`));
    const wrapped = Buffer.concat([pngPrefix, media]);
    const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), wrapped.length - 1) : wrapped.length - 1;
    if (range) {
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${wrapped.length}`);
    }
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Length", end - start + 1);
    response.end(wrapped.subarray(start, end + 1));
    return;
  }
  if (requestUrl.pathname === "/diagnostics/requests") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(requestDiagnostics));
    return;
  }
  if (requestUrl.pathname === "/diagnostics/reset") {
    requestDiagnostics.length = 0;
    response.statusCode = 204;
    response.end();
    return;
  }
  const vlcWrapper = vlcWrappers.get(requestUrl.pathname);
  if (vlcWrapper) {
    rememberFixtureRequest(request, requestUrl.pathname, 200);
    response.setHeader("Content-Type", vlcWrapper.type);
    response.setHeader("Content-Length", Buffer.byteLength(vlcWrapper.body));
    response.end(vlcWrapper.body);
    return;
  }
  if (requestUrl.pathname.startsWith("/context-media/")) {
    const allowedOrigin = request.headers.origin === "http://127.0.0.1:8765";
    const allowedReferrer = request.headers.referer?.startsWith("http://127.0.0.1:8765/");
    const allowedVlc = !request.headers.origin;
    response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:8765");
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    if (!allowedReferrer || (!allowedOrigin && !allowedVlc)) { rememberFixtureRequest(request, requestUrl.pathname, 403); response.statusCode = 403; response.end("site context required"); return; }
    if (requestUrl.pathname === "/context-media/master.m3u8") {
      rememberFixtureRequest(request, requestUrl.pathname, request.headers.range ? 206 : 200);
      response.statusCode = request.headers.range ? 206 : 200;
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      response.setHeader("Content-Length", Buffer.byteLength(contextMaster));
      response.end(contextMaster);
      return;
    }
    if (/^\/context-media\/(?:360|480|720)\.m3u8$/.test(requestUrl.pathname)) {
      rememberFixtureRequest(request, requestUrl.pathname, request.headers.range ? 206 : 200);
      let manifest = await readFile(resolve(fixtures, "media.m3u8"), "utf8");
      manifest = manifest.replace(/segment-(\d+)\.ts/g, "segment-$1.jpeg");
      response.statusCode = request.headers.range ? 206 : 200;
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      response.setHeader("Content-Length", Buffer.byteLength(manifest));
      response.end(manifest);
      return;
    }
    const segmentMatch = requestUrl.pathname.match(/^\/context-media\/segment-(\d+)\.jpeg$/);
    if (segmentMatch) {
      const file = resolve(fixtures, `segment-${segmentMatch[1]}.ts`);
      const info = await stat(file);
      const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (range) {
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
      }
      rememberFixtureRequest(request, requestUrl.pathname, range ? 206 : 200);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Length", end - start + 1);
      response.setHeader("Content-Type", "image/jpeg");
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.statusCode = 404; response.end("not found"); return;
  }
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
