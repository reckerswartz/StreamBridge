import Hls from "hls.js";
import browser from "webextension-polyfill";
import { MESSAGE, type PlayerRequest } from "../shared/types";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const status = document.querySelector<HTMLElement>("#status")!;
const title = document.querySelector<HTMLElement>("#stream-title")!;
let hls: Hls | null = null;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.dataset.error = String(error);
}

async function load(request: PlayerRequest): Promise<void> {
  title.textContent = request.label;
  if (request.kind === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
    if (!Hls.isSupported()) throw new Error("This browser cannot play HLS streams.");
    hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 10 });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) setStatus(`Playback failed: ${data.details}`, true);
    });
    hls.loadSource(request.url);
    hls.attachMedia(video);
    await new Promise<void>((resolve, reject) => {
      hls!.once(Hls.Events.MANIFEST_PARSED, () => resolve());
      hls!.once(Hls.Events.ERROR, (_event, data) => { if (data.fatal) reject(new Error(data.details)); });
    });
  } else {
    video.src = request.url;
  }
  setStatus("Ready. Use the player controls if autoplay is blocked.");
  await video.play().catch(() => setStatus("Press Play to start the verified stream."));
}

const id = new URL(location.href).searchParams.get("id") || "";
browser.runtime.sendMessage({ type: MESSAGE.PLAYER_GET, id }).then((response: any) => {
  if (!response?.request) throw new Error("The player request is missing or expired.");
  return load(response.request);
}).catch((error) => setStatus(error instanceof Error ? error.message : "Unable to load the stream.", true));

window.addEventListener("pagehide", () => hls?.destroy());
