import { MESSAGE } from "../shared/types";

const MAX_OBSERVED_MANIFESTS = 32;
const MAX_URL_LENGTH = 16_384;
const observed = new Set<string>();
const diagnostics = { initialized: true, scanned: 0, reported: 0, pageScans: 0, errors: 0 };
(globalThis as typeof globalThis & { __streamBridgeResourceObserver?: typeof diagnostics }).__streamBridgeResourceObserver = diagnostics;

function remember(url: string): boolean {
  if (observed.has(url)) return false;
  observed.add(url);
  while (observed.size > MAX_OBSERVED_MANIFESTS) observed.delete(observed.values().next().value!);
  return true;
}

function report(entry: PerformanceEntry): void {
  diagnostics.scanned += 1;
  if (entry.entryType !== "resource") return;
  const resource = entry as PerformanceResourceTiming;
  const rawUrl = entry.name;
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) return;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !/\.m3u8?$/i.test(url.pathname)) return;
  if (!remember(url.href)) return;
  diagnostics.reported += 1;
  sendMessage({
    type: MESSAGE.OBSERVED_RESOURCE,
    url: url.href,
    initiatorType: resource.initiatorType || "resource"
  });
}

const observer = new PerformanceObserver((records) => records.getEntries().forEach(report));
try {
  observer.observe({ type: "resource", buffered: true });
} catch {
  observer.observe({ entryTypes: ["resource"] });
}
performance.getEntriesByType("resource").forEach(report);

let scanRequests = 0;
let lastScanAt = 0;
function requestPageScan(): void {
  if (scanRequests >= 8 || (lastScanAt > 0 && performance.now() - lastScanAt < 1_000)) return;
  const player = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).some((video) => {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    const ratio = rect.height > 0 ? rect.width / rect.height : 0;
    return rect.width >= 300 && rect.height >= 168 && ratio >= 1.3 && ratio <= 2.5
      && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
  });
  if (!player) return;
  scanRequests += 1;
  diagnostics.pageScans += 1;
  lastScanAt = performance.now();
  sendMessage({ type: MESSAGE.PAGE_MEDIA_ACTIVATED });
}
const trustedActivation = (event: Event) => { if (event.isTrusted) requestPageScan(); };
for (const type of ["pointerdown", "click"]) {
  window.addEventListener(type, trustedActivation, { capture: true, passive: true });
}

let mediaStateReports = 0;
let lastMediaStateAt = 0;
function reportMediaState(event: Event): void {
  const video = event.target as HTMLVideoElement | null;
  if (video?.tagName !== "VIDEO" || !navigator.userActivation?.hasBeenActive
    || mediaStateReports >= 32 || performance.now() - lastMediaStateAt < 1_000) return;
  const rect = video.getBoundingClientRect();
  const ratio = rect.height > 0 ? rect.width / rect.height : 0;
  if (rect.width < 300 || rect.height < 168 || ratio < 1.3 || ratio > 2.5) return;
  mediaStateReports += 1;
  lastMediaStateAt = performance.now();
  sendMessage({ type: MESSAGE.MEDIA_STATE_CHANGED });
  if (event.type === "play" || event.type === "loadedmetadata") requestPageScan();
}
for (const type of ["emptied", "loadedmetadata", "play", "timeupdate"]) {
  document.addEventListener(type, reportMediaState, { capture: true, passive: true });
}

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) observer.disconnect();
}, { once: true });
function sendMessage(message: Record<string, unknown>): void {
  try {
    const runtime = (globalThis as any).browser?.runtime || chrome.runtime;
    const pending = runtime.sendMessage(message);
    if (pending && typeof pending.catch === "function") pending.catch(() => { diagnostics.errors += 1; });
  } catch { diagnostics.errors += 1; }
}
