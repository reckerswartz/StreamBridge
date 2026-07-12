import browser from "webextension-polyfill";
import { classifyResponse, safeDisplayUrl, stableId } from "./core/classifier";
import { validateCandidate, validationIsFresh } from "./core/validator";
import { MESSAGE, type PlayerRequest, type StreamCandidate } from "./shared/types";

const MAX_STREAMS_PER_TAB = 32;
const tabStreams = new Map<number, StreamCandidate[]>();
const validationQueue: Array<() => Promise<void>> = [];
const injectedTabs = new Set<number>();
let activeValidations = 0;

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
  await browser.storage.session.set({ [tabStorageKey(tabId)]: streams.slice(0, MAX_STREAMS_PER_TAB) });
}

async function clearStreams(tabId: number): Promise<void> {
  tabStreams.delete(tabId);
  await browser.storage.session.remove(tabStorageKey(tabId));
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

async function observedByTopDocument(tabId: number, url: string): Promise<boolean> {
  try {
    const results = await (browser.scripting as any).executeScript({
      target: { tabId },
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

async function playableStreams(tabId: number): Promise<StreamCandidate[]> {
  return (await streamsForTab(tabId)).filter((stream) => validationIsFresh(stream));
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
    activeValidations += 1;
    void job().finally(() => {
      activeValidations -= 1;
      runQueue();
    });
  }
}

function enqueueValidation(tabId: number, candidate: StreamCandidate): void {
  validationQueue.push(async () => {
    const streams = await streamsForTab(tabId);
    const current = streams.find((stream) => stream.id === candidate.id);
    if (!current) return;
    let result = await validateCandidate(current);
    if (result.status === "playable" && !(await observedByTopDocument(tabId, current.url))) {
      result = { status: "rejected", reason: "not-top-document", bytesRead: result.bytesRead };
    }
    Object.assign(current, {
      validationStatus: result.status,
      validationReason: result.reason,
      validatedAt: Date.now(),
      container: result.container,
      variants: result.variants || [],
      durationSeconds: result.durationSeconds
    });
    await persistStreams(tabId, streams);
    if (result.status === "playable") await notifyOverlay(tabId);
  });
  runQueue();
}

async function recordResponse(details: browser.WebRequest.OnHeadersReceivedDetailsType): Promise<void> {
  if (details.tabId < 0 || details.frameId < 0) return;
  const mime = header(details.responseHeaders, "content-type");
  const classified = classifyResponse(details.url, mime);
  if (!classified) return;
  if (!(await belongsToTopDocument(details))) return;
  const streams = await streamsForTab(details.tabId);
  if (streams.some((stream) => stream.url === details.url)) return;
  const candidate: StreamCandidate = {
    id: stableId(details.url),
    tabId: details.tabId,
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
  await persistStreams(details.tabId, streams);
  enqueueValidation(details.tabId, candidate);
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
