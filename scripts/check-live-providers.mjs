import { chromium } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (process.env.STREAMBRIDGE_LIVE_SITES !== "1") {
  console.log("Live provider checks are disabled. Set STREAMBRIDGE_LIVE_SITES=1 explicitly.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const catalogPath = resolve(root, process.env.STREAMBRIDGE_SITE_FILE || "test/sites.local.json");
await access(catalogPath);
const sites = JSON.parse(await readFile(catalogPath, "utf8")).filter((site) => Array.isArray(site.serverLabels));
if (!sites.length) throw new Error("No provider-matrix entries were found in the site catalog.");

const profile = await mkdtemp(resolve(tmpdir(), "streambridge-providers-"));
const headed = process.env.HEADED === "1";
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: !headed,
  args: [
    `--disable-extensions-except=${resolve(root, "dist/chrome")}`,
    `--load-extension=${resolve(root, "dist/chrome")}`,
    "--disable-blink-features=AutomationControlled"
  ]
});

const generatedAt = new Date().toISOString();
const outputDirectory = resolve(root, ".tmp/live-matrix", generatedAt.replaceAll(":", "-"));
const results = [];
const providerFilter = String(process.env.STREAMBRIDGE_PROVIDER || "").trim().toUpperCase();
await mkdir(outputDirectory, { recursive: true });

async function writeReport() {
  const report = { generatedAt, browser: "Chromium", headed, results };
  await writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

function safeLocation(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s"']+/gi, (value) => safeLocation(value))
    .replace(/(authorization|cookie|signature|token)=?[^\s&]*/gi, "$1=[redacted]")
    .slice(0, 180);
}

function exactText(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
}

function frameTree(rootFrame) {
  const frames = [];
  const visit = (frame) => {
    frames.push(frame);
    for (const child of frame.childFrames()) visit(child);
  };
  if (rootFrame) visit(rootFrame);
  return frames;
}

async function providerFrame(page, selector) {
  const element = await page.locator(selector).elementHandle().catch(() => null);
  return element?.contentFrame() || null;
}

async function videoState(frames) {
  const states = [];
  for (const frame of frames) {
    const state = await frame.evaluate(() => ({
      activated: Boolean(navigator.userActivation?.hasBeenActive),
      activationArmed: Boolean(globalThis.__streamBridgeActivationArmed),
      resources: globalThis.performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /m3u8|\.mp4(?:$|\?)/i.test(name)).slice(-12),
      videos: [...document.querySelectorAll("video")].map((video) => {
        const rect = video.getBoundingClientRect();
        return {
          currentTime: Number(video.currentTime.toFixed(2)),
          duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
          paused: video.paused,
          readyState: video.readyState,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
    })).catch(() => null);
    if (state?.videos.length) states.push({
      document: safeLocation(frame.url()),
      activated: state.activated,
      activationArmed: state.activationArmed,
      resources: state.resources.map(safeLocation),
      videos: state.videos
    });
  }
  return states;
}

async function clickPlayer(frames) {
  for (const frame of frames) {
    const videoIndex = await frame.locator("video").evaluateAll((videos) => {
      let selected = -1;
      let selectedArea = 0;
      videos.forEach((video, index) => {
        const rect = video.getBoundingClientRect();
        const ratio = rect.height > 0 ? rect.width / rect.height : 0;
        const area = rect.width * rect.height;
        if (rect.width >= 300 && rect.height >= 168 && ratio >= 1.3 && ratio <= 2.5 && area > selectedArea) {
          selected = index;
          selectedArea = area;
        }
      });
      return selected;
    }).catch(() => -1);
    if (videoIndex < 0) continue;
    const playControl = frame.locator([
      "button[aria-label*='play' i]",
      ".jw-icon-playback",
      ".vjs-big-play-button",
      ".plyr__control--overlaid",
      "button.play",
      ".play-button"
    ].join(",")).first();
    if (await playControl.isVisible().catch(() => false)) {
      await playControl.click({ timeout: 3_000 }).catch(() => undefined);
      return;
    }
    const video = frame.locator("video").nth(videoIndex);
    if (await video.isVisible().catch(() => false)) {
      await video.click({ position: { x: 24, y: 24 }, timeout: 3_000 }).catch(() => undefined);
      await video.evaluate((element) => {
        element.muted = true;
        void element.play().catch(() => undefined);
      }).catch(() => undefined);
      return;
    }
  }
  for (const frame of frames) {
    const playControl = frame.locator("button[aria-label*='play' i],.jw-icon-playback,.vjs-big-play-button,.plyr__control--overlaid,button.play,.play-button").first();
    if (await playControl.isVisible().catch(() => false)) {
      await playControl.click({ timeout: 3_000 }).catch(() => undefined);
      return;
    }
  }
}

async function waitPastChallenge(page) {
  if (!/just a moment/i.test(await page.title())) return true;
  await page.waitForFunction(() => !/just a moment/i.test(document.title), undefined, { timeout: 35_000 }).catch(() => undefined);
  return !/just a moment/i.test(await page.title());
}

async function installDiagnosticEmbed(page, site, serverLabel) {
  const fallback = site.diagnosticEmbed;
  if (!fallback) return false;
  return page.evaluate(({ fallback, serverLabel }) => {
    const buttons = [...document.querySelectorAll(fallback.buttonSelector)];
    const button = buttons.find((item) => item.textContent?.trim().toUpperCase() === serverLabel.toUpperCase());
    const container = document.querySelector(fallback.containerSelector);
    const link = button?.getAttribute(fallback.linkAttribute || "data-link");
    if (!container || !link) return false;
    const target = new URL(fallback.embedBase);
    target.searchParams.set(fallback.linkParameter || "l", link);
    if (fallback.backgroundParameter) target.searchParams.set(fallback.backgroundParameter, container.getAttribute(fallback.backgroundAttribute || "bg") || "");
    const iframe = document.createElement("iframe");
    iframe.id = fallback.frameId || "video";
    iframe.allowFullscreen = true;
    iframe.allow = "autoplay; fullscreen";
    iframe.style.cssText = "display:block;width:100%;height:100%;border:0";
    iframe.src = target.href;
    container.replaceChildren(iframe);
    return true;
  }, { fallback, serverLabel });
}

async function storedCandidates(worker, pageUrl) {
  return worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url === url);
    if (!tab?.id) return [];
    const key = `streams:${tab.id}`;
    const stored = await chrome.storage.session.get(key);
    const candidates = Array.isArray(stored[key]) ? stored[key] : [];
    return candidates.map((candidate) => ({
      kind: candidate.kind,
      accessMode: candidate.accessMode || "portable",
      adapter: candidate.adapter || null,
      container: candidate.container || null,
      variantCount: Array.isArray(candidate.variants) ? candidate.variants.length : 0,
      displayUrl: String(candidate.displayUrl || "").replace(/\?.*$/, "")
    }));
  }, pageUrl);
}

async function openFirstCandidate(context, page) {
  const host = page.locator("#streambridge-host");
  if (!await host.count()) return { attempted: false, advanced: false, status: "overlay-unavailable" };
  await host.evaluate((element) => {
    const panel = element.shadowRoot?.querySelector("#panel");
    if (!panel?.classList.contains("open")) (element.shadowRoot?.querySelector("#toggle"))?.click();
  });
  const action = await host.evaluate((element) => {
    const card = element.shadowRoot?.querySelector(".card");
    const button = card?.querySelector("button.primary");
    return button?.textContent || "";
  });
  if (action !== "Play in Browser") return { attempted: false, advanced: false, status: action || "no-browser-action" };
  const playerPromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url().includes("/player/index.html"), timeout: 10_000 });
  await host.evaluate((element) => element.shadowRoot?.querySelector(".card button.primary")?.click());
  const player = await playerPromise;
  await player.waitForLoadState("domcontentloaded");
  await player.waitForTimeout(1_000);
  const start = player.locator("#start-playback");
  if (await start.isVisible().catch(() => false)) await start.click().catch(() => undefined);
  const advanced = await player.locator("video").evaluate(async (video) => {
    const startAt = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    return video.currentTime > startAt + 0.5;
  }).catch(() => false);
  const status = await player.locator("#status").textContent().catch(() => "player-unavailable");
  await player.close();
  return { attempted: true, advanced, status: String(status || "").slice(0, 120) };
}

try {
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const worker = context.serviceWorkers()[0];
  context.on("page", (popup) => {
    void popup.opener().then((opener) => {
      if (!opener) return;
      setTimeout(() => {
        if (!popup.isClosed() && !popup.url().includes("/player/index.html")) void popup.close();
      }, 1_500);
    });
  });

  for (const site of sites) {
    for (const server of site.serverLabels) {
      if (providerFilter && server.toUpperCase() !== providerFilter) continue;
      const page = await context.newPage();
      const failures = [];
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "document" || /m3u8|\.mp4(?:$|\?)/i.test(request.url())) failures.push({ resource: safeLocation(request.url()), reason: safeError(request.failure()?.errorText || "failed") });
      });
      const row = {
        site: site.name,
        page: safeLocation(site.url),
        server,
        outcome: "extension-failure",
        diagnosticEmbedUsed: false,
        providerDocuments: [],
        candidates: [],
        sourcePlayback: [],
        browserPlayback: { attempted: false, advanced: false, status: "not-attempted" },
        failures: []
      };
      try {
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 35_000 });
        if (!await waitPastChallenge(page)) {
          row.outcome = "blocked-challenge";
          continue;
        }
        const selector = site.serverSelector || "a.btn-server";
        const button = page.locator(selector).filter({ hasText: exactText(server) }).first();
        if (!await button.count()) throw new Error(`Server control ${server} was not found.`);
        await button.click({ timeout: 10_000 });
        await page.waitForTimeout(1_500);
        let rootFrame = await providerFrame(page, site.providerFrameSelector || "iframe#video");
        if (!rootFrame) {
          row.diagnosticEmbedUsed = await installDiagnosticEmbed(page, site, server);
          await page.waitForTimeout(3_000);
          rootFrame = await providerFrame(page, site.providerFrameSelector || "iframe#video");
        }
        if (!rootFrame) throw new Error("The selected server did not create a provider frame.");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await clickPlayer(frameTree(rootFrame));
          await page.waitForTimeout(attempt === 0 ? 3_000 : 2_000);
          rootFrame = await providerFrame(page, site.providerFrameSelector || "iframe#video") || rootFrame;
        }
        const frames = frameTree(rootFrame);
        row.sourcePlayback = await videoState(frames);
        row.providerDocuments = [...new Set([
          safeLocation(rootFrame.url()),
          ...row.sourcePlayback.filter((document) => document.videos.some((video) => {
            const ratio = video.height > 0 ? video.width / video.height : 0;
            return video.width >= 300 && video.height >= 168 && ratio >= 1.3 && ratio <= 2.5;
          })).map((document) => document.document)
        ].filter((value) => value !== "unavailable"))];
        await page.waitForTimeout(Number(site.waitAfterPlayMs) || 5_000);
        row.candidates = await storedCandidates(worker, page.url());
        row.browserPlayback = await openFirstCandidate(context, page);
        const sourceAdvanced = row.sourcePlayback.some((document) => document.videos.some((video) => {
          const ratio = video.height > 0 ? video.width / video.height : 0;
          return video.currentTime > 0.5 && !video.paused
            && video.width >= 300 && video.height >= 168 && ratio >= 1.3 && ratio <= 2.5;
        }));
        const primary = row.candidates[0];
        if (row.browserPlayback.advanced) row.outcome = primary?.adapter ? "played-adapter" : "played-standard";
        else if (sourceAdvanced && primary?.accessMode === "site-context") row.outcome = "site-context-only";
        else if (sourceAdvanced && !primary) row.outcome = "extension-failure";
        else if (failures.length) row.outcome = "blocked-upstream";
        else row.outcome = "provider-no-playback";
      } catch (error) {
        row.failures.push({ resource: "runner", reason: safeError(error) });
        if (/ERR_|SSL|certificate|timeout|navigation|provider frame/i.test(safeError(error))) row.outcome = "blocked-upstream";
      } finally {
        row.failures.push(...failures.slice(0, 8));
        results.push(row);
        await writeReport();
        if (!page.isClosed()) await page.close();
      }
      console.log(JSON.stringify({ site: row.site, server: row.server, outcome: row.outcome, candidates: row.candidates.length, browserAdvanced: row.browserPlayback.advanced }));
    }
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

const reportPath = resolve(outputDirectory, "report.json");
await writeReport();
console.log(`Sanitized live-provider report: ${reportPath}`);

if (results.some((result) => result.outcome === "extension-failure")) process.exitCode = 1;
