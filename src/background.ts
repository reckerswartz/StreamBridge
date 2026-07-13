import browser from "webextension-polyfill";
import { classifyResponse, safeDisplayUrl, stableId } from "./core/classifier";
import { validateInPageContext } from "./core/page-validator";
import { validateCandidate, validationIsFresh } from "./core/validator";
import { MESSAGE, type PlayerContext, type PlayerRequest, type StreamCandidate } from "./shared/types";

const MAX_STREAMS_PER_TAB = 32;
const MAX_PENDING_PER_TAB = 4;
const MAX_PENDING_GLOBAL = 64;
const MAX_SEEN_PER_TAB = 64;
const MAX_DEFERRED_PER_TAB = 8;
const MAX_PAGE_CONFIG_CANDIDATES = 16;
const DEFERRED_TTL_MS = 5 * 60 * 1000;
const tabStreams = new Map<number, StreamCandidate[]>();
interface ValidationJob { tabId: number; candidateId: string; generation: number; done: (accepted: boolean) => void }
const validationQueue: ValidationJob[] = [];
const pendingValidations = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const seenByTab = new Map<number, Map<string, number>>();
const tabGeneration = new Map<number, number>();
const injectedTabs = new Set<number>();
interface DeferredResponse {
  tabId: number;
  frameId: number;
  url: string;
  sourceDocumentUrl: string;
  kind: StreamCandidate["kind"];
  mime: string;
  exactBytes?: number;
  firstSeenAt: number;
  observedVia: StreamCandidate["observedVia"];
}
const deferredByTab = new Map<number, DeferredResponse[]>();
const armedFrames = new Set<string>();
let activeValidations = 0;

function validationKey(tabId: number, candidateId: string): string {
  return `${tabId}:${candidateId}`;
}

function generationFor(tabId: number): number {
  return tabGeneration.get(tabId) || 0;
}

function releaseGenerationIfIdle(tabId: number): void {
  const queued = validationQueue.some((job) => job.tabId === tabId);
  const active = [...activeControllers.keys()].some((key) => key.startsWith(`${tabId}:`));
  if (!queued && !active && !tabStreams.has(tabId)) tabGeneration.delete(tabId);
}

function rememberCandidate(tabId: number, candidateId: string): void {
  const seen = seenByTab.get(tabId) || new Map<string, number>();
  seen.delete(candidateId);
  seen.set(candidateId, Date.now());
  while (seen.size > MAX_SEEN_PER_TAB) seen.delete(seen.keys().next().value!);
  seenByTab.set(tabId, seen);
}

function wasRecentlySeen(tabId: number, candidateId: string): boolean {
  const seenAt = seenByTab.get(tabId)?.get(candidateId);
  return Boolean(seenAt && Date.now() - seenAt <= 5 * 60 * 1000);
}

function tabStorageKey(tabId: number): string {
  return `streams:${tabId}`;
}

function deferredStorageKey(tabId: number): string {
  return `deferred:${tabId}`;
}

async function streamsForTab(tabId: number): Promise<StreamCandidate[]> {
  const cached = tabStreams.get(tabId);
  if (cached) return cached;
  const key = tabStorageKey(tabId);
  const stored = await browser.storage.session.get(key);
  const streams = Array.isArray(stored[key]) ? (stored[key] as StreamCandidate[]).slice(0, MAX_STREAMS_PER_TAB) : [];
  tabStreams.set(tabId, streams);
  return streams;
}

async function persistStreams(tabId: number, streams: StreamCandidate[]): Promise<void> {
  tabStreams.set(tabId, streams);
  if (!streams.length) {
    await browser.storage.session.remove(tabStorageKey(tabId));
    return;
  }
  await browser.storage.session.set({ [tabStorageKey(tabId)]: streams.slice(0, MAX_STREAMS_PER_TAB) });
}

async function clearStreams(tabId: number): Promise<void> {
  tabGeneration.set(tabId, generationFor(tabId) + 1);
  tabStreams.delete(tabId);
  seenByTab.delete(tabId);
  deferredByTab.delete(tabId);
  for (const key of armedFrames) if (key.startsWith(`${tabId}:`)) armedFrames.delete(key);
  for (let index = validationQueue.length - 1; index >= 0; index -= 1) {
    const job = validationQueue[index];
    if (job.tabId !== tabId) continue;
    pendingValidations.delete(validationKey(job.tabId, job.candidateId));
    validationQueue.splice(index, 1);
    job.done(false);
  }
  for (const [key, controller] of activeControllers) {
    if (!key.startsWith(`${tabId}:`)) continue;
    controller.abort(new Error("tab-closed"));
  }
  await browser.storage.session.remove([tabStorageKey(tabId), deferredStorageKey(tabId)]);
  releaseGenerationIfIdle(tabId);
}

function header(headers: browser.WebRequest.HttpHeaders | undefined, name: string): string {
  return headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function requestDocumentUrl(details: browser.WebRequest.OnHeadersReceivedDetailsType): string {
  const requestContext = details as browser.WebRequest.OnHeadersReceivedDetailsType & {
    documentUrl?: string;
    originUrl?: string;
    initiator?: string;
  };
  return requestContext.documentUrl || requestContext.originUrl || requestContext.initiator || "";
}

interface QualifiedFrame {
  playerContext: PlayerContext;
  sourceDocumentUrl: string;
}

interface FrameInspection extends QualifiedFrame {
  deferred: boolean;
}

async function inspectRequestFrame(details: browser.WebRequest.OnHeadersReceivedDetailsType): Promise<FrameInspection | null> {
  const sourceDocumentUrl = requestDocumentUrl(details);
  return inspectTabFrame(details.tabId, details.frameId, sourceDocumentUrl);
}

async function inspectTabFrame(tabId: number, frameId: number, sourceDocumentUrl = ""): Promise<FrameInspection | null> {
  try {
    const tab = await browser.tabs.get(tabId);
    const results = await (browser.scripting as any).executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        const video = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).some((item) => {
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          const ratio = rect.height > 0 ? rect.width / rect.height : 0;
          return rect.width >= 300 && rect.height >= 168 && ratio >= 1.3 && ratio <= 2.5
            && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
        });
        return { video, activated: Boolean(navigator.userActivation?.hasBeenActive) };
      }
    });
    const result = results.find((item: { result?: { video?: boolean; activated?: boolean } }) => item.result?.video)?.result;
    if (!result?.video) return null;
    return {
      playerContext: frameId === 0 ? "top" : "embedded",
      sourceDocumentUrl: sourceDocumentUrl || tab.url || "",
      deferred: !result.activated
    };
  } catch {
    return null;
  }
}

function frameKey(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

async function deferredForTab(tabId: number): Promise<DeferredResponse[]> {
  const cached = deferredByTab.get(tabId);
  if (cached) return cached;
  const key = deferredStorageKey(tabId);
  const stored = await browser.storage.session.get(key);
  const deferred = Array.isArray(stored[key]) ? (stored[key] as DeferredResponse[]) : [];
  deferredByTab.set(tabId, deferred);
  return deferred;
}

async function rememberDeferred(response: DeferredResponse): Promise<void> {
  const fresh = (await deferredForTab(response.tabId))
    .filter((item) => Date.now() - item.firstSeenAt <= DEFERRED_TTL_MS && item.url !== response.url);
  fresh.unshift(response);
  if (fresh.length > MAX_DEFERRED_PER_TAB) fresh.length = MAX_DEFERRED_PER_TAB;
  deferredByTab.set(response.tabId, fresh);
  await browser.storage.session.set({ [deferredStorageKey(response.tabId)]: fresh });
}

async function armFrameActivation(tabId: number, frameId: number): Promise<void> {
  const key = frameKey(tabId, frameId);
  if (armedFrames.has(key)) return;
  armedFrames.add(key);
  try {
    await (browser.scripting as any).executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        const state = globalThis as typeof globalThis & { __streamBridgeActivationArmed?: boolean };
        if (state.__streamBridgeActivationArmed) return;
        state.__streamBridgeActivationArmed = true;
        document.addEventListener("click", () => {
          state.__streamBridgeActivationArmed = false;
          const runtime = (globalThis as any).browser?.runtime || (globalThis as any).chrome?.runtime;
          void runtime?.sendMessage({ type: "streambridge:frame-activated" });
        }, { once: true });
      }
    });
  } catch {
    armedFrames.delete(key);
  }
}

async function observedByDocument(candidate: StreamCandidate): Promise<boolean> {
  try {
    const results = await (browser.scripting as any).executeScript({
      target: { tabId: candidate.tabId, frameIds: [candidate.frameId] },
      args: [candidate.url, candidate.kind, candidate.observedVia],
      func: (targetUrl: string, kind: StreamCandidate["kind"], observedVia?: StreamCandidate["observedVia"]) => {
        const resourceMatch = performance.getEntriesByType("resource").some((entry) => entry.name === targetUrl);
        const matchingMedia = Array.from(document.querySelectorAll<HTMLMediaElement>("video,audio")).filter((media) => media.currentSrc === targetUrl || media.src === targetUrl);
        const mediaMatch = matchingMedia.length > 0;
        if (!(resourceMatch || mediaMatch || observedVia === "page-config")) return false;
        const videos = kind === "file" ? matchingMedia.filter((media): media is HTMLVideoElement => media instanceof HTMLVideoElement) : Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
        const activated = Boolean(navigator.userActivation?.hasBeenActive);
        const visiblePlayer = (video: HTMLVideoElement) => {
          const rect = video.getBoundingClientRect();
          const style = getComputedStyle(video);
          const ratio = rect.height > 0 ? rect.width / rect.height : 0;
          return rect.width >= 300 && rect.height >= 168 && ratio >= 1.3 && ratio <= 2.5
            && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
        };
        if (observedVia === "page-config") return activated && videos.some(visiblePlayer);
        return activated && videos.some((video) => visiblePlayer(video)
          && !video.paused && video.readyState >= 2 && video.currentTime > 0);
      }
    });
    return results.some((item: { result?: boolean }) => item.result === true);
  } catch {
    return false;
  }
}

async function waitForDocumentObservation(candidate: StreamCandidate): Promise<boolean> {
  const attempts = 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await observedByDocument(candidate)) return true;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function mayUsePageContext(reason: string): boolean {
  return /^(?:http-(?:401|403)|not-hls|unknown-media|validation-timeout|failed to fetch|load failed|networkerror)/i.test(reason);
}

async function validateWithPageContext(candidate: StreamCandidate): Promise<Awaited<ReturnType<typeof validateCandidate>>> {
  try {
    const results = await (browser.scripting as any).executeScript({
      target: { tabId: candidate.tabId, frameIds: [candidate.frameId] },
      world: "MAIN",
      args: [candidate.url, candidate.kind],
      func: validateInPageContext
    });
    const result = results.find((item: { result?: unknown }) => item.result)?.result;
    if (result && typeof result === "object") return result as Awaited<ReturnType<typeof validateCandidate>>;
    return { status: "rejected", reason: "page-context-no-result", bytesRead: 0 };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message.slice(0, 80) : "page-context-error", bytesRead: 0 };
  }
}

async function playableStreams(tabId: number): Promise<StreamCandidate[]> {
  const key = tabStorageKey(tabId);
  const stored = await browser.storage.session.get(key);
  const persisted = Array.isArray(stored[key]) ? (stored[key] as StreamCandidate[]).slice(0, MAX_STREAMS_PER_TAB) : [];
  tabStreams.set(tabId, persisted);
  const fresh = persisted.filter((stream) => validationIsFresh(stream));
  const variantUrls = new Set(fresh.flatMap((stream) => stream.variants.map((variant) => variant.url)));
  return fresh.filter((stream) => !variantUrls.has(stream.url));
}

async function ensureOverlay(tabId: number): Promise<void> {
  if (!injectedTabs.has(tabId)) {
    await (browser.scripting as any).executeScript({ target: { tabId }, files: ["content-overlay.js"] });
    injectedTabs.add(tabId);
  }
}

async function notifyOverlay(tabId: number): Promise<void> {
  const streams = await playableStreams(tabId);
  if (!streams.length) {
    await browser.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    if (injectedTabs.has(tabId)) {
      await browser.tabs.sendMessage(tabId, { type: MESSAGE.OVERLAY_UPDATE, streams: [] }).catch(() => undefined);
    }
    return;
  }
  try {
    await ensureOverlay(tabId);
    await browser.tabs.sendMessage(tabId, { type: MESSAGE.OVERLAY_UPDATE, streams });
    await browser.action.setBadgeText({ tabId, text: String(streams.length) });
    await browser.action.setBadgeBackgroundColor({ tabId, color: "#5b35f2" });
  } catch {
    injectedTabs.delete(tabId);
  }
}

function runQueue(): void {
  while (activeValidations < 2 && validationQueue.length) {
    const activeTabs = new Set([...activeControllers.keys()].map((key) => Number(key.split(":", 1)[0])));
    const nextIndex = validationQueue.findIndex((candidate) => !activeTabs.has(candidate.tabId));
    if (nextIndex < 0) return;
    const [job] = validationQueue.splice(nextIndex, 1);
    if (!job) return;
    const key = validationKey(job.tabId, job.candidateId);
    const controller = new AbortController();
    activeControllers.set(key, controller);
    activeValidations += 1;
    void runValidation(job, controller.signal).catch(async () => {
      const streams = await streamsForTab(job.tabId);
      await persistStreams(job.tabId, streams.filter((stream) => stream.id !== job.candidateId));
    }).finally(() => {
      pendingValidations.delete(key);
      activeControllers.delete(key);
      releaseGenerationIfIdle(job.tabId);
      activeValidations -= 1;
      job.done(true);
      runQueue();
    });
  }
}

async function runValidation(job: ValidationJob, signal: AbortSignal): Promise<void> {
  if (job.generation !== generationFor(job.tabId)) return;
  const streams = await streamsForTab(job.tabId);
  const current = streams.find((stream) => stream.id === job.candidateId);
  if (!current) return;
  let result = current.observedVia === "page-config"
    ? await validateWithPageContext(current)
    : await validateCandidate(current, signal);
  if (signal.aborted || job.generation !== generationFor(job.tabId)) return;
  const observed = await waitForDocumentObservation(current);
  if (!observed) result = { status: "rejected", reason: "not-active-player-frame", bytesRead: result.bytesRead };
  else if (result.status === "rejected" && mayUsePageContext(result.reason)) {
    result = await validateWithPageContext(current);
  }
  if (signal.aborted || job.generation !== generationFor(job.tabId)) return;
  if (result.status === "rejected") {
    await persistStreams(job.tabId, streams.filter((stream) => stream.id !== job.candidateId));
    return;
  }
  Object.assign(current, {
    validationStatus: result.status,
    validationReason: result.reason,
    accessMode: result.accessMode || "portable",
    validatedAt: Date.now(),
    container: result.container,
    variants: result.variants || [],
    durationSeconds: result.durationSeconds,
    adapter: result.adapter
  });
  await persistStreams(job.tabId, streams);
  await pruneDerivedVariants(job.tabId);
  await pruneSupersededFiles(job.tabId, current.frameId);
  await notifyOverlay(job.tabId);
}

async function pruneDerivedVariants(tabId: number): Promise<void> {
  const streams = await streamsForTab(tabId);
  const variantUrls = new Set(streams
    .filter((stream) => validationIsFresh(stream))
    .flatMap((stream) => stream.variants.map((variant) => variant.url)));
  if (!variantUrls.size) return;
  const removedIds = new Set(streams.filter((stream) => variantUrls.has(stream.url)).map((stream) => stream.id));
  if (!removedIds.size) return;
  for (let index = validationQueue.length - 1; index >= 0; index -= 1) {
    const job = validationQueue[index];
    if (job.tabId !== tabId || !removedIds.has(job.candidateId)) continue;
    validationQueue.splice(index, 1);
    pendingValidations.delete(validationKey(job.tabId, job.candidateId));
    job.done(false);
  }
  await persistStreams(tabId, streams.filter((stream) => !removedIds.has(stream.id)));
}

async function pruneSupersededFiles(tabId: number, frameId: number): Promise<void> {
  const streams = await streamsForTab(tabId);
  const hlsCutoff = Math.max(0, ...streams
    .filter((stream) => stream.frameId === frameId && stream.kind === "hls" && validationIsFresh(stream))
    .map((stream) => stream.firstSeenAt));
  if (!hlsCutoff) return;
  const configuredHls = streams.some((stream) => stream.frameId === frameId
    && stream.kind === "hls" && stream.observedVia === "page-config" && validationIsFresh(stream));
  let activeMedia: string[] = [];
  try {
    const results = await (browser.scripting as any).executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => Array.from(document.querySelectorAll<HTMLMediaElement>("video,audio"))
        .filter((media) => {
          const rect = media.getBoundingClientRect();
          const style = getComputedStyle(media);
          const ratio = rect.height > 0 ? rect.width / rect.height : 0;
          return !media.paused && media.readyState >= 2
            && rect.width >= 300 && rect.height >= 168 && ratio >= 1.3 && ratio <= 2.5
            && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
        })
        .flatMap((media) => [media.currentSrc, media.src].filter(Boolean))
    });
    activeMedia = results.flatMap((item: { result?: string[] }) => item.result || []);
  } catch { return; }
  const active = new Set(activeMedia);
  const filtered = streams.filter((stream) => !(stream.frameId === frameId
    && stream.kind === "file"
    && (configuredHls || !active.has(stream.url))));
  if (filtered.length !== streams.length) await persistStreams(tabId, filtered);
}

function enqueueValidation(tabId: number, candidate: StreamCandidate): Promise<boolean> {
  const key = validationKey(tabId, candidate.id);
  if (pendingValidations.has(key)) return Promise.resolve(false);
  const perTab = validationQueue.filter((job) => job.tabId === tabId).length
    + [...activeControllers.keys()].filter((activeKey) => activeKey.startsWith(`${tabId}:`)).length;
  if (perTab >= MAX_PENDING_PER_TAB || pendingValidations.size >= MAX_PENDING_GLOBAL) return Promise.resolve(false);
  pendingValidations.add(key);
  return new Promise((resolve) => {
    validationQueue.push({ tabId, candidateId: candidate.id, generation: generationFor(tabId), done: resolve });
    runQueue();
  });
}

async function recordQualifiedResponse(response: DeferredResponse, qualifiedFrame: QualifiedFrame): Promise<void> {
  const streams = await streamsForTab(response.tabId);
  const candidateId = stableId(response.url);
  const existing = streams.find((stream) => stream.url === response.url);
  if (existing) {
    if (response.observedVia === "page-config" && existing.observedVia !== "page-config") {
      existing.observedVia = "page-config";
      existing.sourceDocumentUrl = qualifiedFrame.sourceDocumentUrl;
      await persistStreams(response.tabId, streams);
    }
    return;
  }
  if (response.observedVia !== "page-config" && wasRecentlySeen(response.tabId, candidateId)) return;
  const candidate: StreamCandidate = {
    id: candidateId,
    tabId: response.tabId,
    frameId: response.frameId,
    playerContext: qualifiedFrame.playerContext,
    sourceDocumentUrl: qualifiedFrame.sourceDocumentUrl,
    url: response.url,
    displayUrl: safeDisplayUrl(response.url),
    kind: response.kind,
    mime: response.mime,
    firstSeenAt: response.firstSeenAt,
    observedVia: response.observedVia,
    validationStatus: "checking",
    exactBytes: response.exactBytes,
    variants: []
  };
  streams.unshift(candidate);
  if (streams.length > MAX_STREAMS_PER_TAB) streams.length = MAX_STREAMS_PER_TAB;
  rememberCandidate(response.tabId, candidate.id);
  await persistStreams(response.tabId, streams);
  if (!(await enqueueValidation(response.tabId, candidate))) {
    const index = streams.findIndex((stream) => stream.id === candidate.id);
    if (index >= 0) streams.splice(index, 1);
    await persistStreams(response.tabId, streams);
    return;
  }
}

async function activateDeferredFrame(tabId: number, frameId: number): Promise<void> {
  armedFrames.delete(frameKey(tabId, frameId));
  // Let the site's click handler start its player before checking playback state.
  // The activation message is sent from a bubbling click listener, but some
  // players still enqueue their network and media work in the next task.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const now = Date.now();
  let deferred = (await deferredForTab(tabId)).filter((item) => now - item.firstSeenAt <= DEFERRED_TTL_MS);
  if (!deferred.some((item) => item.frameId === frameId)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    deferredByTab.delete(tabId);
    deferred = (await deferredForTab(tabId)).filter((item) => now - item.firstSeenAt <= DEFERRED_TTL_MS);
  }
  const selected = deferred.filter((item) => item.frameId === frameId);
  const remaining = deferred.filter((item) => item.frameId !== frameId);
  if (remaining.length) {
    deferredByTab.set(tabId, remaining);
    await browser.storage.session.set({ [deferredStorageKey(tabId)]: remaining });
  } else {
    deferredByTab.delete(tabId);
    await browser.storage.session.remove(deferredStorageKey(tabId));
  }
  await Promise.all(selected.map((response) => recordQualifiedResponse(response, {
    playerContext: frameId === 0 ? "top" : "embedded",
    sourceDocumentUrl: response.sourceDocumentUrl
  })));
}

async function recordResponse(details: browser.WebRequest.OnHeadersReceivedDetailsType): Promise<void> {
  if (details.incognito || details.tabId < 0 || details.frameId < 0) return;
  const mime = header(details.responseHeaders, "content-type");
  const classified = classifyResponse(details.url, mime, details.type);
  if (!classified) return;
  const inspectedFrame = await inspectRequestFrame(details);
  if (!inspectedFrame) return;
  const response: DeferredResponse = {
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    sourceDocumentUrl: inspectedFrame.sourceDocumentUrl,
    kind: classified.kind,
    mime: classified.mime,
    exactBytes: Number(header(details.responseHeaders, "content-length")) || undefined,
    firstSeenAt: Date.now(),
    observedVia: "web-request"
  };
  if (inspectedFrame.deferred) {
    const persistence = rememberDeferred(response);
    await armFrameActivation(details.tabId, details.frameId);
    await persistence;
    const refreshed = await inspectRequestFrame(details);
    if (refreshed && !refreshed.deferred) await activateDeferredFrame(details.tabId, details.frameId);
    return;
  }
  await recordQualifiedResponse(response, inspectedFrame);
}

browser.webRequest.onHeadersReceived.addListener((details) => { void recordResponse(details); }, { urls: ["<all_urls>"] }, ["responseHeaders"]);

async function discoverPageMedia(tabId: number, frameId: number): Promise<string[]> {
  try {
    const results = await (browser.scripting as any).executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: (maximum: number) => {
        const urls = new Map<string, string>();
        const add = (value: unknown) => {
          if (typeof value !== "string" || value.length > 16_384 || urls.size >= maximum) return;
          try {
            const url = new URL(value, location.href);
            if (url.protocol !== "http:" && url.protocol !== "https:") return;
            if (!/\.m3u8?$/i.test(url.pathname)) return;
            const canonicalLocation = `${url.hostname.toLowerCase()}${url.pathname}`;
            if (!urls.has(canonicalLocation)) urls.set(canonicalLocation, url.href);
          } catch { /* ignore non-URL strings */ }
        };
        const roots: unknown[] = [];
        try {
          const descriptors = Object.getOwnPropertyDescriptors(globalThis);
          for (const [name, descriptor] of Object.entries(descriptors)) {
            if (!/(?:flash|player|video|media|stream|config)/i.test(name) || !("value" in descriptor)) continue;
            const value = descriptor.value;
            if (value && typeof value === "object" && !(value instanceof Node)) roots.push(value);
          }
        } catch { /* hostile page globals are skipped */ }
        const queue = roots.slice(0, 64).map((value) => ({ value, depth: 0 }));
        const visited = new WeakSet<object>();
        let inspected = 0;
        while (queue.length && inspected < 2_000 && urls.size < maximum) {
          const item = queue.shift()!;
          if (!item.value || typeof item.value !== "object" || visited.has(item.value as object)) continue;
          if (item.value instanceof Node || item.value instanceof Window || item.value instanceof Document) continue;
          visited.add(item.value as object);
          inspected += 1;
          let descriptors: PropertyDescriptorMap;
          try { descriptors = Object.getOwnPropertyDescriptors(item.value); } catch { continue; }
          for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor)) continue;
            if (typeof descriptor.value === "string") add(descriptor.value);
            else if (item.depth < 4 && descriptor.value && typeof descriptor.value === "object") {
              queue.push({ value: descriptor.value, depth: item.depth + 1 });
            }
          }
        }
        return [...urls.values()];
      },
      args: [MAX_PAGE_CONFIG_CANDIDATES]
    });
    return results.flatMap((item: { result?: string[] }) => item.result || []).slice(0, MAX_PAGE_CONFIG_CANDIDATES);
  } catch { return []; }
}

browser.runtime.onMessage.addListener(async (message: any, sender: browser.Runtime.MessageSender) => {
  const tabId = Number(message?.tabId ?? sender.tab?.id);
  if (message?.type === MESSAGE.MEDIA_STATE_CHANGED && sender.tab?.id !== undefined && sender.frameId !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await pruneSupersededFiles(sender.tab.id, sender.frameId);
    await notifyOverlay(sender.tab.id);
    return { ok: true };
  }
  if (message?.type === MESSAGE.PAGE_MEDIA_ACTIVATED && sender.tab?.id !== undefined && sender.frameId !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const inspectedFrame = await inspectTabFrame(sender.tab.id, sender.frameId, sender.url || "");
    if (!inspectedFrame || inspectedFrame.deferred) return { ok: false };
    const urls = await discoverPageMedia(sender.tab.id, sender.frameId);
    for (const rawUrl of urls) {
      const classified = classifyResponse(rawUrl);
      if (!classified || classified.kind !== "hls") continue;
      await recordQualifiedResponse({
        tabId: sender.tab.id,
        frameId: sender.frameId,
        url: rawUrl,
        sourceDocumentUrl: inspectedFrame.sourceDocumentUrl,
        kind: classified.kind,
        mime: classified.mime,
        firstSeenAt: Date.now(),
        observedVia: "page-config"
      }, inspectedFrame);
    }
    return { ok: urls.length > 0 };
  }
  if (message?.type === MESSAGE.OBSERVED_RESOURCE && sender.tab?.id !== undefined && sender.frameId !== undefined) {
    const rawUrl = String(message.url || "");
    const classified = classifyResponse(rawUrl, "", String(message.initiatorType || "resource"));
    if (!classified || classified.kind !== "hls") return { ok: false };
    const inspectedFrame = await inspectTabFrame(sender.tab.id, sender.frameId, sender.url || "");
    if (!inspectedFrame) return { ok: false };
    const response: DeferredResponse = {
      tabId: sender.tab.id,
      frameId: sender.frameId,
      url: rawUrl,
      sourceDocumentUrl: inspectedFrame.sourceDocumentUrl,
      kind: classified.kind,
      mime: classified.mime,
      firstSeenAt: Date.now(),
      observedVia: "resource-timing"
    };
    if (inspectedFrame.deferred) {
      const persistence = rememberDeferred(response);
      await armFrameActivation(sender.tab.id, sender.frameId);
      await persistence;
      const refreshed = await inspectTabFrame(sender.tab.id, sender.frameId, sender.url || "");
      if (refreshed && !refreshed.deferred) await activateDeferredFrame(sender.tab.id, sender.frameId);
      return { ok: true };
    }
    await recordQualifiedResponse(response, inspectedFrame);
    return { ok: true };
  }
  if (message?.type === MESSAGE.FRAME_ACTIVATED && sender.tab?.id !== undefined && sender.frameId !== undefined) {
    await activateDeferredFrame(sender.tab.id, sender.frameId);
    return { ok: true };
  }
  if (message?.type === MESSAGE.LIST && Number.isInteger(tabId)) return { streams: await playableStreams(tabId) };
  if (message?.type === MESSAGE.CLEAR && Number.isInteger(tabId)) {
    await clearStreams(tabId);
    await browser.action.setBadgeText({ tabId, text: "" });
    return { streams: [] };
  }
  if (message?.type === MESSAGE.OPEN_PLAYER && sender.tab?.id !== undefined) {
    const sourceStreams = await playableStreams(sender.tab.id);
    const requestedUrl = String(message.url || "");
    const parent = sourceStreams.find((stream) => stream.url === requestedUrl || stream.variants.some((variant) => variant.url === requestedUrl));
    if (!parent) throw new Error("The requested stream is not verified or has expired.");
    if (parent.accessMode === "site-context") throw new Error("This stream must be played from its source website.");
    const request: PlayerRequest = {
      id: crypto.randomUUID(),
      url: requestedUrl,
      kind: "hls",
      label: parent.displayUrl,
      adapter: parent.adapter,
      createdAt: Date.now()
    };
    if (parent.kind === "file" && parent.url === requestedUrl) request.kind = "file";
    await browser.storage.session.set({ [`player:${request.id}`]: request });
    await browser.tabs.create({ url: browser.runtime.getURL(`player/index.html?id=${encodeURIComponent(request.id)}`) });
    return { ok: true };
  }
  if (message?.type === MESSAGE.RESUME_SITE_PLAYER && sender.tab?.id !== undefined) {
    const sourceStreams = await playableStreams(sender.tab.id);
    const requestedId = String(message.streamId || "");
    const stream = sourceStreams.find((item) => item.id === requestedId);
    if (!stream || stream.accessMode !== "site-context") throw new Error("The source player is no longer verified.");
    const results = await (browser.scripting as any).executeScript({
      target: { tabId: sender.tab.id, frameIds: [stream.frameId] },
      func: async () => {
        const media = Array.from(document.querySelectorAll<HTMLMediaElement>("video,audio"))
          .filter((item) => item.currentSrc || item.src)
          .sort((left, right) => {
            const score = (item: HTMLMediaElement) => {
              const rect = item.getBoundingClientRect();
              return (item.paused ? 0 : 1_000_000_000) + Math.max(0, rect.width) * Math.max(0, rect.height);
            };
            return score(right) - score(left);
          })[0];
        if (!media) return false;
        media.scrollIntoView({ behavior: "smooth", block: "center" });
        await media.play();
        return true;
      }
    });
    if (!results.some((item: { result?: boolean }) => item.result === true)) throw new Error("The website player is no longer available. Start playback again.");
    return { ok: true };
  }
  if (message?.type === MESSAGE.PLAYER_GET) {
    const id = String(message.id || "");
    const key = `player:${id}`;
    const stored = await browser.storage.session.get(key);
    const request = stored[key] as PlayerRequest | undefined;
    if (!request || Date.now() - request.createdAt > 10 * 60 * 1000) return { request: null };
    await browser.storage.session.remove(key);
    return { request };
  }
  return undefined;
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  void clearStreams(tabId);
  injectedTabs.delete(tabId);
  void browser.action.setBadgeText({ tabId, text: "" });
});

browser.tabs.onRemoved.addListener((tabId) => {
  void clearStreams(tabId);
  injectedTabs.delete(tabId);
});
