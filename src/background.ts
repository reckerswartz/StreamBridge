import browser from "webextension-polyfill";
import { classifyResponse, safeDisplayUrl, stableId } from "./core/classifier";
import { validateInPageContext } from "./core/page-validator";
import { validateCandidate, validationIsFresh } from "./core/validator";
import { MESSAGE, type PlayerRequest, type StreamCandidate } from "./shared/types";

const MAX_STREAMS_PER_TAB = 32;
const MAX_PENDING_PER_TAB = 4;
const MAX_PENDING_GLOBAL = 64;
const MAX_SEEN_PER_TAB = 64;
const tabStreams = new Map<number, StreamCandidate[]>();
interface ValidationJob { tabId: number; candidateId: string; generation: number }
const validationQueue: ValidationJob[] = [];
const pendingValidations = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const seenByTab = new Map<number, Map<string, number>>();
const tabGeneration = new Map<number, number>();
const injectedTabs = new Set<number>();
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
  for (let index = validationQueue.length - 1; index >= 0; index -= 1) {
    const job = validationQueue[index];
    if (job.tabId !== tabId) continue;
    pendingValidations.delete(validationKey(job.tabId, job.candidateId));
    validationQueue.splice(index, 1);
  }
  for (const [key, controller] of activeControllers) {
    if (!key.startsWith(`${tabId}:`)) continue;
    controller.abort(new Error("tab-closed"));
  }
  await browser.storage.session.remove(tabStorageKey(tabId));
  releaseGenerationIfIdle(tabId);
}

function header(headers: browser.WebRequest.HttpHeaders | undefined, name: string): string {
  return headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function origin(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

async function belongsToTopDocument(details: browser.WebRequest.OnHeadersReceivedDetailsType): Promise<boolean> {
  const requestContext = details as browser.WebRequest.OnHeadersReceivedDetailsType & {
    documentUrl?: string;
    originUrl?: string;
    initiator?: string;
  };
  const contextOrigin = origin(requestContext.documentUrl || requestContext.originUrl || requestContext.initiator);
  if (!contextOrigin) return details.frameId === 0;
  try {
    const tab = await browser.tabs.get(details.tabId);
    return contextOrigin === origin(tab.url);
  } catch {
    return false;
  }
}

async function observedByDocument(tabId: number, frameId: number, url: string): Promise<boolean> {
  try {
    const results = await (browser.scripting as any).executeScript({
      target: { tabId, frameIds: [frameId] },
      args: [url],
      func: (targetUrl: string) => {
        const resourceMatch = performance.getEntriesByType("resource").some((entry) => entry.name === targetUrl);
        const mediaMatch = Array.from(document.querySelectorAll<HTMLMediaElement>("video,audio")).some((media) => media.currentSrc === targetUrl || media.src === targetUrl);
        return resourceMatch || mediaMatch;
      }
    });
    return results.some((item: { result?: boolean }) => item.result === true);
  } catch {
    return false;
  }
}

async function waitForDocumentObservation(tabId: number, frameId: number, url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await observedByDocument(tabId, frameId, url)) return true;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100));
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
  const fresh = (await streamsForTab(tabId)).filter((stream) => validationIsFresh(stream));
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
  if (!streams.length) return;
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
    const job = validationQueue.shift();
    if (!job) return;
    const key = validationKey(job.tabId, job.candidateId);
    const controller = new AbortController();
    activeControllers.set(key, controller);
    activeValidations += 1;
    void runValidation(job, controller.signal).finally(() => {
      pendingValidations.delete(key);
      activeControllers.delete(key);
      releaseGenerationIfIdle(job.tabId);
      activeValidations -= 1;
      runQueue();
    });
  }
}

async function runValidation(job: ValidationJob, signal: AbortSignal): Promise<void> {
  if (job.generation !== generationFor(job.tabId)) return;
  const streams = await streamsForTab(job.tabId);
  const current = streams.find((stream) => stream.id === job.candidateId);
  if (!current) return;
  let result = await validateCandidate(current, signal);
  if (signal.aborted || job.generation !== generationFor(job.tabId)) return;
  const observed = await waitForDocumentObservation(job.tabId, current.frameId, current.url);
  if (!observed) result = { status: "rejected", reason: "not-top-document", bytesRead: result.bytesRead };
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
    durationSeconds: result.durationSeconds
  });
  await persistStreams(job.tabId, streams);
  await notifyOverlay(job.tabId);
}

function enqueueValidation(tabId: number, candidate: StreamCandidate): boolean {
  const key = validationKey(tabId, candidate.id);
  if (pendingValidations.has(key)) return false;
  const perTab = validationQueue.filter((job) => job.tabId === tabId).length
    + [...activeControllers.keys()].filter((activeKey) => activeKey.startsWith(`${tabId}:`)).length;
  if (perTab >= MAX_PENDING_PER_TAB || pendingValidations.size >= MAX_PENDING_GLOBAL) return false;
  pendingValidations.add(key);
  validationQueue.push({ tabId, candidateId: candidate.id, generation: generationFor(tabId) });
  runQueue();
  return true;
}

async function recordResponse(details: browser.WebRequest.OnHeadersReceivedDetailsType): Promise<void> {
  if (details.incognito || details.tabId < 0 || details.frameId < 0) return;
  const mime = header(details.responseHeaders, "content-type");
  const classified = classifyResponse(details.url, mime);
  if (!classified) return;
  if (!(await belongsToTopDocument(details))) return;
  const streams = await streamsForTab(details.tabId);
  const candidateId = stableId(details.url);
  if (streams.some((stream) => stream.url === details.url) || wasRecentlySeen(details.tabId, candidateId)) return;
  const candidate: StreamCandidate = {
    id: candidateId,
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    displayUrl: safeDisplayUrl(details.url),
    kind: classified.kind,
    mime: classified.mime,
    firstSeenAt: Date.now(),
    validationStatus: "checking",
    exactBytes: Number(header(details.responseHeaders, "content-length")) || undefined,
    variants: []
  };
  streams.unshift(candidate);
  if (streams.length > MAX_STREAMS_PER_TAB) streams.length = MAX_STREAMS_PER_TAB;
  if (!enqueueValidation(details.tabId, candidate)) {
    const index = streams.findIndex((stream) => stream.id === candidate.id);
    if (index >= 0) streams.splice(index, 1);
    return;
  }
  rememberCandidate(details.tabId, candidate.id);
  await persistStreams(details.tabId, streams);
}

browser.webRequest.onHeadersReceived.addListener((details) => { void recordResponse(details); }, { urls: ["<all_urls>"] }, ["responseHeaders"]);

browser.runtime.onMessage.addListener(async (message: any, sender: browser.Runtime.MessageSender) => {
  const tabId = Number(message?.tabId ?? sender.tab?.id);
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
      createdAt: Date.now()
    };
    if (parent.kind === "file" && parent.url === requestedUrl) request.kind = "file";
    await browser.storage.session.set({ [`player:${request.id}`]: request });
    await browser.tabs.create({ url: browser.runtime.getURL(`player/index.html?id=${encodeURIComponent(request.id)}`) });
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
