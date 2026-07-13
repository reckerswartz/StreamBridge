import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("captures after Play, reveals verified overlay, and plays in the browser", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "streambridge-e2e-"));
  const extension = process.env.STREAMBRIDGE_EXTENSION_DIR
    ? resolve(process.env.STREAMBRIDGE_EXTENSION_DIR)
    : resolve(import.meta.dirname, "../../dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    permissions: ["clipboard-read", "clipboard-write"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8765/fixture");
    await expect(page.locator("#streambridge-host")).toHaveCount(0);
    await page.locator("#play-direct").click();
    const host = page.locator("#streambridge-host");
    await expect(host).toHaveCount(1, { timeout: 12_000 });
    await expect.poll(() => host.evaluate((element) => element.shadowRoot?.querySelector("#count")?.textContent)).toBe("1");
    await host.evaluate((element) => (element.shadowRoot?.querySelector("#toggle") as HTMLButtonElement).click());
    await expect.poll(() => host.evaluate((element) => element.shadowRoot?.querySelector("#panel")?.classList.contains("open"))).toBe(true);
    const labels = await host.evaluate((element) => [...element.shadowRoot!.querySelectorAll("button")].map((button) => button.textContent));
    expect(labels).toEqual(expect.arrayContaining(["Play in Browser", "Send to player", "Copy URL", "Share"]));
    const portableDownloadPromise = page.waitForEvent("download");
    await host.evaluate((element) => {
      const send = [...element.shadowRoot!.querySelectorAll("button")].find((button) => button.textContent === "Send to player") as HTMLButtonElement;
      send.click();
    });
    const portableDownload = await portableDownloadPromise;
    const portablePlaylist = await readFile((await portableDownload.path())!, "utf8");
    expect(portablePlaylist).not.toContain("#EXTVLCOPT:http-referrer=");
    expect(portablePlaylist).toContain("/media/sample.mp4?token=fixture-secret");
    await host.evaluate((element) => {
      const copy = [...element.shadowRoot!.querySelectorAll("button")].find((button) => button.textContent === "Copy URL") as HTMLButtonElement;
      copy.click();
    });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("/media/sample.mp4?token=fixture-secret");
    const playerPromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url().includes("/player/index.html") });
    await host.evaluate((element) => (element.shadowRoot?.querySelector("button.primary") as HTMLButtonElement).click());
    const player = await playerPromise;
    await player.waitForLoadState("domcontentloaded");
    await expect.poll(() => player.locator("video").evaluate((video) => (video as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
    await expect(player.locator("#status")).not.toHaveAttribute("data-error", "true");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("validates HLS, renders quality metadata, and plays through hls.js", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "streambridge-hls-"));
  const extension = process.env.STREAMBRIDGE_EXTENSION_DIR
    ? resolve(process.env.STREAMBRIDGE_EXTENSION_DIR)
    : resolve(import.meta.dirname, "../../dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8765/fixture");
    await page.locator("#request-hls").click();
    const host = page.locator("#streambridge-host");
    await expect(host).toHaveCount(1, { timeout: 12_000 });
    await host.evaluate((element) => (element.shadowRoot!.querySelector("#toggle") as HTMLButtonElement).click());
    await expect.poll(() => host.evaluate((element) => element.shadowRoot!.textContent)).toContain("640×360");
    const playerPromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url().includes("/player/index.html") });
    await host.evaluate((element) => (element.shadowRoot!.querySelector("button.primary") as HTMLButtonElement).click());
    const player = await playerPromise;
    await player.waitForLoadState("domcontentloaded");
    await expect.poll(() => player.locator("video").evaluate((video) => (video as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("labels referrer-dependent HLS as site-context and resumes the website player", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "streambridge-context-"));
  const extension = process.env.STREAMBRIDGE_EXTENSION_DIR
    ? resolve(process.env.STREAMBRIDGE_EXTENSION_DIR)
    : resolve(import.meta.dirname, "../../dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    permissions: ["clipboard-read", "clipboard-write"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8765/fixture/context");
    await page.locator("#start-context").click();
    const host = page.locator("#streambridge-host");
    await expect(host).toHaveCount(1, { timeout: 12_000 });
    await expect.poll(() => host.evaluate((element) => element.shadowRoot!.textContent), { timeout: 15_000 }).toContain("Site-context");
    await host.evaluate((element) => (element.shadowRoot!.querySelector("#toggle") as HTMLButtonElement).click());
    const overlayText = await host.evaluate((element) => element.shadowRoot!.textContent || "");
    expect(overlayText).toContain("640×360");
    expect(overlayText).toContain("842×480");
    expect(overlayText).toContain("1280×720");
    expect(overlayText).toContain("may fail in another player or browser");

    const video = page.locator("#context-video");
    await video.evaluate((element) => (element as HTMLVideoElement).pause());
    const pausedAt = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    await host.evaluate((element) => {
      const button = [...element.shadowRoot!.querySelectorAll("button")].find((item) => item.textContent === "Resume site player") as HTMLButtonElement;
      button.click();
    });
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 12_000 }).toBeGreaterThan(pausedAt + 0.25);

    const downloadPromise = page.waitForEvent("download");
    await host.evaluate((element) => {
      const contextCard = [...element.shadowRoot!.querySelectorAll<HTMLElement>(".card")].find((item) => item.textContent?.includes("Site-context"))!;
      const open = [...contextCard.querySelectorAll("button")].find((item) => item.textContent === "Send to player") as HTMLButtonElement;
      open.click();
    });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^streambridge-.+\.m3u$/);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const playlist = await readFile(downloadPath!, "utf8");
    expect(playlist).toContain("#EXTVLCOPT:http-referrer=http://127.0.0.1:8765/");
    expect(playlist).toContain("#EXTVLCOPT:http-user-agent=");
    expect(playlist).toContain("http://localhost:8765/context-media/master.m3u8?token=context-fixture");
    expect(playlist).not.toContain("/fixture/context");

    await host.evaluate((element) => {
      const contextCard = [...element.shadowRoot!.querySelectorAll<HTMLElement>(".card")].find((item) => item.textContent?.includes("Site-context"))!;
      const copy = [...contextCard.querySelectorAll("button")].find((item) => item.textContent === "Copy URL") as HTMLButtonElement;
      copy.click();
    });
    await expect.poll(() => host.evaluate((element) => element.shadowRoot!.querySelector("#status")?.textContent)).toContain("may require the source website");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("/context-media/master.m3u8");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("discovers bounded HLS page configuration and removes a superseded pre-roll file", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "streambridge-page-config-"));
  const extension = process.env.STREAMBRIDGE_EXTENSION_DIR
    ? resolve(process.env.STREAMBRIDGE_EXTENSION_DIR)
    : resolve(import.meta.dirname, "../../dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const worker = context.serviceWorkers()[0];
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8765/fixture/page-config");
    await expect.poll(() => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:8765/fixture/page-config" });
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: () => Boolean((globalThis as any).__streamBridgeResourceObserver?.initialized) });
      return result[0]?.result;
    })).toBe(true);
    await page.locator("#start-config").click();
    await expect.poll(() => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:8765/fixture/page-config" });
      const key = `streams:${tab.id}`;
      const stored = await chrome.storage.session.get(key);
      const streams = Array.isArray(stored[key]) ? stored[key] : [];
      return streams.some((stream) => stream.kind === "hls"
        && stream.observedVia === "page-config"
        && stream.accessMode === "site-context"
        && stream.variants.some((variant: any) => variant.quality === "720p"));
    }), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:8765/fixture/page-config" });
      const key = `streams:${tab.id}`;
      const stored = await chrome.storage.session.get(key);
      const streams = Array.isArray(stored[key]) ? stored[key] : [];
      return streams.some((stream) => String(stream.url).includes("pre-roll=fixture"));
    }), { timeout: 12_000 }).toBe(false);
    const host = page.locator("#streambridge-host");
    await expect(host).toHaveCount(1, { timeout: 12_000 });
    await expect.poll(() => host.evaluate((element) => element.shadowRoot!.textContent)).toContain("Site-context");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("captures a user-activated cross-origin player and ignores an autoplay ad frame", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "streambridge-embedded-"));
  const extension = process.env.STREAMBRIDGE_EXTENSION_DIR
    ? resolve(process.env.STREAMBRIDGE_EXTENSION_DIR)
    : resolve(import.meta.dirname, "../../dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const worker = context.serviceWorkers()[0];
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8765/fixture/embedded");
    await page.waitForTimeout(2_000);
    await expect(page.locator("#streambridge-host")).toHaveCount(0);
    await expect.poll(() => worker.evaluate(async () => {
      const stored = await chrome.storage.session.get(null);
      return Object.entries(stored).filter(([key]) => key.startsWith("deferred:")).reduce((count, [, value]) => count + (Array.isArray(value) ? value.length : 0), 0);
    })).toBeGreaterThan(0);
    await expect.poll(() => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:8765/fixture/embedded" });
      const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, func: () => Boolean((globalThis as any).__streamBridgeActivationArmed) });
      return frames.filter((frame) => frame.result).length;
    })).toBeGreaterThan(0);

    await page.frameLocator("#embedded-player").locator("#embedded-play").click();
    await expect.poll(() => worker.evaluate(async () => {
      const stored = await chrome.storage.session.get(null);
      return Object.entries(stored).filter(([key]) => key.startsWith("streams:")).reduce((count, [, value]) => count + (Array.isArray(value) ? value.length : 0), 0);
    }), { timeout: 15_000 }).toBeGreaterThan(0);
    const host = page.locator("#streambridge-host");
    await expect(host).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => host.evaluate((element) => element.shadowRoot?.querySelector("#count")?.textContent)).toBe("1");
    await host.evaluate((element) => (element.shadowRoot!.querySelector("#toggle") as HTMLButtonElement).click());
    await expect.poll(() => host.evaluate((element) => element.shadowRoot!.textContent)).toContain("master.m3u8");

    const playerPromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url().includes("/player/index.html") });
    await host.evaluate((element) => (element.shadowRoot!.querySelector("button.primary") as HTMLButtonElement).click());
    const player = await playerPromise;
    await player.waitForLoadState("domcontentloaded");
    await expect.poll(() => player.locator("video").evaluate((video) => (video as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("identifies PNG-prefixed MPEG-TS and replays it with the browser adapter", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "streambridge-adapter-"));
  const extension = process.env.STREAMBRIDGE_EXTENSION_DIR
    ? resolve(process.env.STREAMBRIDGE_EXTENSION_DIR)
    : resolve(import.meta.dirname, "../../dist/chrome");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const worker = context.serviceWorkers()[0];
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8765/fixture/adapter");
    await expect.poll(() => worker.evaluate(async () => {
      const stored = await chrome.storage.session.get(null);
      return Object.entries(stored).filter(([key]) => key.startsWith("deferred:")).reduce((count, [, value]) => count + (Array.isArray(value) ? value.length : 0), 0);
    }), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.locator("#adapter-play").click();
    const host = page.locator("#streambridge-host");
    await expect(host).toHaveCount(1, { timeout: 15_000 });
    await host.evaluate((element) => (element.shadowRoot!.querySelector("#toggle") as HTMLButtonElement).click());
    await expect.poll(() => host.evaluate((element) => element.shadowRoot!.textContent), { timeout: 15_000 }).toContain("Browser adapter");
    const labels = await host.evaluate((element) => {
      const card = [...element.shadowRoot!.querySelectorAll<HTMLElement>(".card")].find((item) => item.textContent?.includes("Browser adapter"))!;
      return [...card.querySelectorAll("button")].map((button) => button.textContent);
    });
    expect(labels).toEqual(expect.arrayContaining(["Play in Browser", "Copy source URL"]));
    expect(labels).not.toContain("Send to player");
    const playerPromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url().includes("/player/index.html") });
    await host.evaluate((element) => {
      const card = [...element.shadowRoot!.querySelectorAll<HTMLElement>(".card")].find((item) => item.textContent?.includes("Browser adapter"))!;
      (card.querySelector("button.primary") as HTMLButtonElement).click();
    });
    const player = await playerPromise;
    await player.waitForLoadState("domcontentloaded");
    const startPlayback = player.locator("#start-playback");
    await player.waitForTimeout(500);
    if (await startPlayback.isVisible()) await startPlayback.click();
    await expect.poll(() => player.locator("video").evaluate((video) => (video as HTMLVideoElement).currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
    await expect(player.locator("#status")).not.toHaveAttribute("data-error", "true");
    await expect(player.locator("#status")).toContainText("browser adapter");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
