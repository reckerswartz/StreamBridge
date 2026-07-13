import Hls from "hls.js";
import browser from "webextension-polyfill";
import { adapterFragmentLoader } from "./adapter-loader";
import { MESSAGE, type PlayerRequest } from "../shared/types";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const status = document.querySelector<HTMLElement>("#status")!;
const title = document.querySelector<HTMLElement>("#stream-title")!;
const startPlayback = document.querySelector<HTMLButtonElement>("#start-playback")!;
let hls: Hls | null = null;
let fatalPlaybackError = false;
let activeRequest: PlayerRequest | null = null;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.dataset.error = String(error);
}

async function playVideo(request: PlayerRequest): Promise<void> {
  try {
    await video.play();
    startPlayback.hidden = true;
    if (request.adapter && !fatalPlaybackError) setStatus("Playing with the browser adapter. Unmute from the player controls when ready.");
  } catch (error) {
    if (fatalPlaybackError) return;
    startPlayback.hidden = false;
    status.dataset.details = error instanceof Error ? error.message : "autoplay-blocked";
    setStatus("Press Start playback to begin the verified stream.");
  }
}

async function load(request: PlayerRequest): Promise<void> {
  activeRequest = request;
  title.textContent = request.label;
  if (request.adapter) video.muted = true;
  // Adapter streams must always pass through hls.js so its fragment loader can
  // unwrap transformed segments, even in browsers that advertise native HLS.
  if (request.kind === "hls" && (Boolean(request.adapter) || !video.canPlayType("application/vnd.apple.mpegurl"))) {
    if (!Hls.isSupported()) throw new Error("This browser cannot play HLS streams.");
    hls = new Hls({
      maxBufferLength: 12,
      maxMaxBufferLength: 24,
      backBufferLength: 6,
      ...(request.adapter ? { fLoader: adapterFragmentLoader(request.adapter) } : {})
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        fatalPlaybackError = true;
        status.dataset.details = [data.details, data.reason, data.error?.message].filter(Boolean).join(": ");
        setStatus(`Playback failed: ${data.details}`, true);
      }
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
  if (!fatalPlaybackError) setStatus(request.adapter ? "Ready with the browser adapter. Use the player controls if autoplay is blocked." : "Ready. Use the player controls if autoplay is blocked.");
  await playVideo(request);
}

startPlayback.addEventListener("click", () => {
  if (activeRequest) void playVideo(activeRequest);
});

const id = new URL(location.href).searchParams.get("id") || "";
browser.runtime.sendMessage({ type: MESSAGE.PLAYER_GET, id }).then((response: any) => {
  if (!response?.request) throw new Error("The player request is missing or expired.");
  return load(response.request);
}).catch((error) => setStatus(error instanceof Error ? error.message : "Unable to load the stream.", true));

window.addEventListener("pagehide", () => hls?.destroy());
