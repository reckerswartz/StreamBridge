import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { connectToFirefox } from "../node_modules/web-ext/lib/firefox/rdp-client.js";
import { enableFirefoxRemoteDebugging } from "./android-firefox-ui.mjs";

if (process.env.STREAMBRIDGE_LIVE_SITES !== "1") {
  console.log("Android live checks are disabled. Set STREAMBRIDGE_LIVE_SITES=1 explicitly.");
  process.exit(0);
}

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(homedir(), "Android/Sdk");
const adb = process.env.ADB_BIN || resolve(sdk, "platform-tools/adb");
const emulatorBinary = process.env.EMULATOR_BIN || resolve(sdk, "emulator/emulator");
const device = process.env.ADB_DEVICE || "emulator-5554";
const avd = process.env.ANDROID_AVD || "tnfr_uat_api36";
const firefoxPackage = process.env.FIREFOX_PACKAGE || "org.mozilla.firefox";
const firefoxApk = process.env.FIREFOX_ANDROID_APK || resolve(root, ".tmp/android/firefox-152.0.5-x86_64.apk");
const vlcVersion = "3.7.0";
const vlcPackage = "org.videolan.vlc";
const bridgePackage = "com.streambridge.bridge";
const cacheDirectory = resolve(root, ".tmp/android");
const vlcApk = process.env.VLC_ANDROID_APK || resolve(cacheDirectory, `VLC-Android-${vlcVersion}-x86_64.apk`);
const vlcBase = `https://get.videolan.org/vlc-android/${vlcVersion}/VLC-Android-${vlcVersion}-x86_64.apk`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = resolve(root, ".tmp/live-android", stamp);
const siteFile = resolve(root, process.env.STREAMBRIDGE_SITE_FILE || "test/sites.local.json");
const site = JSON.parse(await readFile(siteFile, "utf8")).find((entry) => entry.livePlayback === true);
if (!site) throw new Error("No livePlayback entry was found in the local site catalog.");
const siteUrl = new URL(site.url);

let emulatorProcess;
let webExtProcess;
let startedEmulator = false;
let rdpPort;
const evidence = { sourceAdvance: 0, sourcePlayback: false, overlayQualities: [], vlcPositions: [], vlcSuccessfulResponses: [], vlcObservedStates: [], processMemory: {}, failures: [] };

function sleep(milliseconds) { return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)); }
function withTimeout(promise, label, milliseconds = 20_000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds))]);
}
async function adbCommand(args, options = {}) { return exec(adb, ["-s", device, ...args], { maxBuffer: 30 * 1024 * 1024, ...options }); }

async function ensureEmulator() {
  const devices = await exec(adb, ["devices"]);
  if (devices.stdout.includes(`${device}\tdevice`)) return;
  emulatorProcess = spawn(emulatorBinary, ["-avd", avd, "-no-window", "-gpu", "swiftshader_indirect", "-no-snapshot-load", "-no-audio", "-no-boot-anim"], { stdio: ["ignore", "pipe", "pipe"] });
  startedEmulator = true;
  await exec(adb, ["wait-for-device"]);
  for (let attempt = 0; attempt < 75; attempt += 1) {
    const { stdout } = await adbCommand(["shell", "getprop", "sys.boot_completed"]).catch(() => ({ stdout: "" }));
    if (stdout.trim() === "1") return;
    await sleep(2_000);
  }
  throw new Error("Android emulator did not finish booting.");
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function ensureVlcApk() {
  await mkdir(cacheDirectory, { recursive: true });
  const checksumResponse = await fetch(`${vlcBase}.sha256`);
  if (!checksumResponse.ok) throw new Error(`VLC checksum download returned HTTP ${checksumResponse.status}.`);
  const expected = (await checksumResponse.text()).match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (!expected) throw new Error("The official VLC checksum was invalid.");
  const current = await access(vlcApk).then(() => sha256(vlcApk), () => null);
  if (current === expected) return { path: vlcApk, checksum: expected };
  await rm(vlcApk, { force: true });
  const response = await fetch(vlcBase);
  if (!response.ok || !response.body) throw new Error(`VLC APK download returned HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(vlcApk, { mode: 0o600 }));
  const downloaded = await sha256(vlcApk);
  if (downloaded !== expected) throw new Error("The downloaded VLC APK did not match VideoLAN's SHA-256.");
  return { path: vlcApk, checksum: expected };
}

async function buildBridge() {
  await exec(process.execPath, [resolve(root, "scripts/build-android-bridge.mjs")], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const matches = (await readdir(resolve(root, "artifacts")))
    .filter((name) => /vlc-bridge-debug\.apk$/.test(name))
    .sort();
  if (!matches.length) throw new Error("The debug VLC Bridge APK was not built.");
  return resolve(root, "artifacts", matches.at(-1));
}

async function installApk(path) {
  await adbCommand(["install", "-r", "-d", path], { timeout: 180_000 });
}

async function dismissUiPrompts() {
  let idleAttempts = 0;
  for (let attempt = 0; attempt < 20 && idleAttempts < 5; attempt += 1) {
    await adbCommand(["shell", "uiautomator", "dump", "/sdcard/streambridge-window.xml"]).catch(() => undefined);
    const { stdout } = await adbCommand(["shell", "cat", "/sdcard/streambridge-window.xml"]).catch(() => ({ stdout: "" }));
    const candidates = ["Open", "Skip", "Not now", "Start browsing", "Continue", "Next", "Finish", "Done", "OK", "Got it", "Allow"];
    let tapped = false;
    const tutorialClose = stdout.match(/text="CLOSE"[^>]*resource-id="org\.videolan\.vlc:id\/nextButton"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (tutorialClose) {
      await adbCommand(["shell", "input", "tap", String(Math.round((Number(tutorialClose[1]) + Number(tutorialClose[3])) / 2)), String(Math.round((Number(tutorialClose[2]) + Number(tutorialClose[4])) / 2))]);
      await sleep(700);
      tapped = true;
      idleAttempts = 0;
    }
    for (const label of candidates) {
      if (tapped) break;
      const expression = new RegExp(`(?:text|content-desc)="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, "i");
      const match = stdout.match(expression);
      if (!match) continue;
      await adbCommand(["shell", "input", "tap", String(Math.round((Number(match[1]) + Number(match[3])) / 2)), String(Math.round((Number(match[2]) + Number(match[4])) / 2))]);
      await sleep(700);
      tapped = true;
      idleAttempts = 0;
      break;
    }
    if (!tapped) {
      idleAttempts += 1;
      await sleep(700);
    }
  }
}

async function initializeVlc() {
  await adbCommand(["shell", "appops", "set", vlcPackage, "MANAGE_EXTERNAL_STORAGE", "allow"]).catch(() => undefined);
  await adbCommand(["shell", "monkey", "-p", vlcPackage, "-c", "android.intent.category.LAUNCHER", "1"]).catch(() => undefined);
  await sleep(1_500);
  await dismissUiPrompts();
  await adbCommand(["shell", "am", "force-stop", vlcPackage]);
}

async function installExtension() {
  return new Promise((resolveInstall, rejectInstall) => {
    const child = spawn("npx", ["web-ext", "run", "--source-dir", "dist/firefox", "--target", "firefox-android", "--adb-bin", adb, "--adb-device", device, "--firefox-apk", firefoxPackage, "--no-reload", "--adb-remove-old-artifacts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    webExtProcess = child;
    let output = "";
    const timer = setTimeout(() => rejectInstall(new Error(`Timed out installing Firefox extension. ${output.slice(-500)}`)), 120_000);
    const consume = (chunk) => {
      output += chunk.toString();
      const port = output.match(/TCP port (\d+)/)?.[1];
      if (port && /Installed .*temporary add-on/.test(output)) {
        clearTimeout(timer);
        resolveInstall(Number(port));
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("exit", (code) => { if (code && !output.includes("Installed")) rejectInstall(new Error(`web-ext exited ${code}: ${output.slice(-500)}`)); });
  });
}

function decodeEvaluation(value) {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== "object") throw new Error("Firefox returned an invalid evaluation result.");
  return decoded;
}

async function evaluatePage(port, expression) {
  const client = await withTimeout(connectToFirefox(port), "Firefox RDP connection");
  const evaluations = [];
  const capture = (error) => {
    const match = error.message.match(/Unexpected RDP message received: (\{.*\})$/s);
    if (!match) return;
    const message = JSON.parse(match[1]);
    if (message.type === "evaluationResult") evaluations.push(message);
  };
  client.on("error", capture);
  try {
    const tabs = await withTimeout(client.request("listTabs"), "Firefox tab listing");
    const targetTab = tabs.tabs.find((tab) => {
      try {
        const candidate = new URL(tab.url);
        return candidate.origin === siteUrl.origin && candidate.pathname === siteUrl.pathname;
      } catch {
        return false;
      }
    });
    if (!targetTab) throw new Error("Firefox did not expose the target page tab.");
    const target = await withTimeout(client.request({ to: targetTab.actor, type: "getTarget" }), "Firefox page target");
    const key = `__streamBridgeLive${Date.now()}`;
    const scheduled = `globalThis.${key}=undefined;Promise.resolve(${expression}).then(value=>globalThis.${key}=JSON.stringify(value),error=>globalThis.${key}=JSON.stringify({error:String(error)}));'scheduled'`;
    await withTimeout(client.request({ to: target.frame.consoleActor, type: "evaluateJSAsync", text: scheduled }), "Firefox evaluation scheduling");
    for (let attempt = 0; attempt < 30 && evaluations.length < 1; attempt += 1) await sleep(100);
    await sleep(300);
    const before = evaluations.length;
    await withTimeout(client.request({ to: target.frame.consoleActor, type: "evaluateJSAsync", text: `globalThis.${key}` }), "Firefox evaluation readback");
    for (let attempt = 0; attempt < 30 && evaluations.length <= before; attempt += 1) await sleep(100);
    const evaluation = evaluations.at(-1);
    if (!evaluation || evaluation.hasException) throw new Error(String(evaluation?.exception || "Firefox page evaluation failed."));
    const value = evaluation.result && typeof evaluation.result === "object" && "value" in evaluation.result ? evaluation.result.value : evaluation.result;
    const decoded = decodeEvaluation(value);
    if (decoded.error) throw new Error(decoded.error);
    return decoded;
  } finally { client.disconnect(); }
}

async function tapPageRect(rect) {
  const { stdout } = await adbCommand(["shell", "wm", "size"]);
  const match = stdout.match(/(?:Physical|Override) size:\s*(\d+)x(\d+)/i);
  const width = Number(match?.[1] || 1080);
  const height = Number(match?.[2] || 1920);
  const scale = width / rect.innerWidth;
  const x = Math.round(Math.min(width - 2, Math.max(2, (rect.innerScreenX + rect.x) * (rect.dpr || scale))));
  let y = Math.round((rect.innerScreenY + rect.y) * (rect.dpr || scale));
  if (!Number.isFinite(y) || y < 1 || y >= height) y = Math.round(Math.min(height - 2, Math.max(2, rect.y * scale + (height - rect.innerHeight * scale) / 2)));
  await adbCommand(["shell", "input", "tap", String(x), String(y)]);
  await sleep(500);
}

async function rectFor(port, kind) {
  const selector = kind === "play"
      ? `(()=>{const visible=element=>{const r=element.getBoundingClientRect();const s=getComputedStyle(element);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'};const configured=${JSON.stringify(site.playSelector || "")};const selected=configured?document.querySelector(configured):null;if(selected&&visible(selected))return selected;const controls=[...document.querySelectorAll('[class*="bigPlay"],[aria-label*="play" i]')].filter(visible).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return br.width*br.height-ar.width*ar.height});if(controls[0])return controls[0];return [...document.querySelectorAll('video')].filter(visible).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return br.width*br.height-ar.width*ar.height})[0]})()`
      : kind === "toggle"
        ? `document.querySelector('#streambridge-host')?.shadowRoot?.querySelector('#toggle')`
        : `[...document.querySelector('#streambridge-host')?.shadowRoot?.querySelectorAll('.card')||[]].find(card=>card.textContent?.includes(${JSON.stringify(site.expected?.resumeQuality || "")}))?.querySelectorAll('button')`;
  const expression = kind === "player"
    ? `(()=>{const buttons=${selector};const element=buttons&&[...buttons].find(button=>button.textContent==='Send to player');if(!element)return {found:false};element.scrollIntoView({block:'center',inline:'center'});const r=element.getBoundingClientRect();return {found:true,x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,dpr:devicePixelRatio,innerWidth,innerHeight,innerScreenX:window.mozInnerScreenX||0,innerScreenY:window.mozInnerScreenY||0}})()`
    : `(()=>{const element=${selector};if(!element)return {found:false};const r=element.getBoundingClientRect();return {found:true,x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,dpr:devicePixelRatio,innerWidth,innerHeight,innerScreenX:window.mozInnerScreenX||0,innerScreenY:window.mozInnerScreenY||0}})()`;
  return evaluatePage(port, expression);
}

async function performConfiguredPreActions(port) {
  for (const action of site.preActions || []) {
    if (!action.selector) continue;
    const rect = await evaluatePage(port, `(()=>{const element=document.querySelector(${JSON.stringify(action.selector)});if(!element)return {found:false};const r=element.getBoundingClientRect();return {found:true,x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,dpr:devicePixelRatio,innerWidth,innerHeight,innerScreenX:window.mozInnerScreenX||0,innerScreenY:window.mozInnerScreenY||0}})()`);
    if (!rect.found && !action.optional) throw new Error(`Configured pre-action was unavailable: ${action.selector}`);
    if (rect.found) await tapPageRect(rect);
    await sleep(Number(action.waitAfterMs || 500));
  }
}

async function mobileDiagnostics(port) {
  return evaluatePage(port, `(()=>{const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(item=>{const r=item.getBoundingClientRect();const s=getComputedStyle(item);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'});const videos=[...document.querySelectorAll('video')].map(video=>{const r=video.getBoundingClientRect();return {paused:video.paused,readyState:video.readyState,width:Math.round(r.width),height:Math.round(r.height)}});return {path:location.host+location.pathname,readyState:document.readyState,visibleControlCount:controls.length,videos,overlay:Boolean(document.querySelector('#streambridge-host'))}})()`);
}

async function mediaState(port) {
  return evaluatePage(port, `(()=>{const videos=[...document.querySelectorAll('video')].map(video=>{const r=video.getBoundingClientRect();return {time:Number(video.currentTime.toFixed(2)),paused:video.paused,readyState:video.readyState,area:r.width*r.height,width:r.width,height:r.height}}).sort((a,b)=>b.area-a.area);return {active:navigator.userActivation?.hasBeenActive||false,video:videos[0]||null,overlay:document.querySelector('#streambridge-host')?.shadowRoot?.textContent||''}})()`);
}

async function vlcPosition() {
  const { stdout } = await adbCommand(["shell", "dumpsys", "media_session"]);
  const index = stdout.indexOf(`${vlcPackage}/VLC/`);
  if (index < 0) return null;
  const block = stdout.slice(index, index + 6_000);
  const state = block.match(/state=PlaybackState\s*\{\s*state=[A-Z_]+\((\d+)\),\s*position=(\d+)/i)
    || block.match(/state=(\d+)[\s\S]{0,400}?position=(\d+)/i);
  if (!state) return null;
  return { state: Number(state[1]), position: Number(state[2]) };
}

async function processPss(packageName) {
  const { stdout } = await adbCommand(["shell", "dumpsys", "meminfo", packageName]).catch(() => ({ stdout: "" }));
  return Number(stdout.match(/TOTAL PSS:\s*(\d+)/)?.[1] || stdout.match(/^\s*TOTAL\s+(\d+)/m)?.[1] || 0);
}

async function vlcSuccessfulResponses() {
  const { stdout } = await adbCommand(["shell", "logcat", "-d", "-v", "brief"]);
  return stdout.split("\n").filter((line) => /\bVLC\b.*HTTP\/1\.1 20[06] OK/i.test(line)).length;
}

try {
  await mkdir(reportDirectory, { recursive: true });
  console.log(JSON.stringify({ stage: "android-start", device, avd }));
  await ensureEmulator();
  console.log(JSON.stringify({ stage: "android-ready" }));
  await access(firefoxApk);
  const officialVlc = await ensureVlcApk();
  const bridgeApk = await buildBridge();
  await installApk(firefoxApk);
  await installApk(officialVlc.path);
  await installApk(bridgeApk);
  await adbCommand(["shell", "pm", "clear", vlcPackage]);
  await initializeVlc();
  console.log(JSON.stringify({ stage: "apps-installed", vlcVersion }));
  await adbCommand(["logcat", "-c"]);
  await enableFirefoxRemoteDebugging({ adb, device, firefoxPackage, diagnosticsDirectory: reportDirectory });
  console.log(JSON.stringify({ stage: "firefox-debugging-enabled" }));
  rdpPort = await installExtension();
  console.log(JSON.stringify({ stage: "extension-installed", rdpPort }));
  await sleep(1_500);
  await dismissUiPrompts();
  await adbCommand(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", site.url, firefoxPackage]);
  await sleep(5_000);
  await dismissUiPrompts();
  await performConfiguredPreActions(rdpPort);
  await sleep(Number(site.waitBeforePlayMs || 500));
  const playRect = await rectFor(rdpPort, "play");
  if (!playRect.found) throw new Error("The Firefox page did not expose its play control.");
  await tapPageRect(playRect);
  await sleep(24_000);
  const first = await mediaState(rdpPort);
  await sleep(3_000);
  const second = await mediaState(rdpPort);
  evidence.sourceAdvance = Number(((second.video?.time || 0) - (first.video?.time || 0)).toFixed(2));
  evidence.sourcePlayback = evidence.sourceAdvance >= 1;
  if (!second.active) throw new Error("Firefox did not retain the real ADB user activation.");
  let toggleRect = await rectFor(rdpPort, "toggle");
  for (let attempt = 0; !toggleRect.found && attempt < 10; attempt += 1) {
    await sleep(2_000);
    toggleRect = await rectFor(rdpPort, "toggle");
  }
  if (!toggleRect.found) throw new Error("The Firefox overlay toggle was unavailable.");
  await tapPageRect(toggleRect);
  const expectedQualities = site.expected?.qualities || [];
  let refreshed = await mediaState(rdpPort);
  for (let attempt = 0; attempt < 12 && !expectedQualities.every((quality) => refreshed.overlay.includes(quality)); attempt += 1) {
    await sleep(2_000);
    refreshed = await mediaState(rdpPort);
  }
  for (const quality of expectedQualities) {
    if (!refreshed.overlay.includes(quality)) throw new Error(`Firefox overlay did not show ${quality}.`);
    evidence.overlayQualities.push(quality);
  }
  for (const forbidden of site.expected?.forbiddenHostPatterns || []) {
    if (refreshed.overlay.toLowerCase().includes(forbidden.toLowerCase())) throw new Error(`Firefox overlay retained transient host ${forbidden}.`);
  }
  const playerRect = await rectFor(rdpPort, "player");
  if (!playerRect.found) throw new Error("The configured Send to player action was unavailable.");
  await tapPageRect(playerRect);
  await sleep(5_000);
  await dismissUiPrompts();
  await adbCommand(["shell", "cmd", "media_session", "dispatch", "play"]);
  await sleep(1_000);
  let playing = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    playing = await vlcPosition();
    if (playing) evidence.vlcObservedStates.push(playing);
    if (playing?.state === 3) break;
    if (playing?.state === 2 && attempt % 3 === 0) {
      await adbCommand(["shell", "cmd", "media_session", "dispatch", "play"]);
    }
    await sleep(2_000);
  }
  if (!playing || playing.state !== 3) throw new Error("VLC did not enter the playing media-session state.");
  evidence.vlcPositions.push(playing.position);
  const initialResponses = await vlcSuccessfulResponses();
  evidence.vlcSuccessfulResponses.push(initialResponses);
  await sleep(4_000);
  const later = await vlcPosition();
  const laterResponses = await vlcSuccessfulResponses();
  if (!later || later.state !== 3 || (later.position < playing.position + 2_000 && laterResponses <= initialResponses)) {
    throw new Error("VLC playback did not advance by position or successful HLS responses.");
  }
  evidence.vlcPositions.push(later.position);
  evidence.vlcSuccessfulResponses.push(laterResponses);
  evidence.processMemory = {
    firefoxPssKiB: await processPss(firefoxPackage),
    bridgePssKiB: await processPss(bridgePackage),
    vlcPssKiB: await processPss(vlcPackage)
  };
  const { stdout: rawLog } = await adbCommand(["logcat", "-d", "-v", "threadtime"]);
  const log = rawLog.split("\n").filter((line) => /Firefox|Gecko|WebExtension|StreamBridge|VLC|ActivityManager|ANR|crash|FATAL/i.test(line)).join("\n")
    .replace(/\b(?:https?|streambridge-vlc):\/\/[^\s]+/gi, "<url-redacted>")
    .replace(/(token|signature|cookie|authorization)=?[^&\s]*/gi, "$1=[redacted]");
  if (/ANR in (?:org\.mozilla\.firefox|org\.videolan\.vlc|com\.streambridge\.bridge)|FATAL EXCEPTION[^\n]*(?:org\.mozilla\.firefox|org\.videolan\.vlc|com\.streambridge\.bridge)/i.test(log)) {
    throw new Error("Firefox, VLC, or the VLC Bridge crashed or stopped responding.");
  }
  await writeFile(resolve(reportDirectory, "android-live.log"), `${log}\n`);
  await writeFile(resolve(reportDirectory, "report.json"), `${JSON.stringify({ result: "pass", generatedAt: new Date().toISOString(), device, avd, startedEmulator, site: new URL(site.url).host + new URL(site.url).pathname, vlc: { version: vlcVersion, checksum: officialVlc.checksum }, evidence }, null, 2)}\n`);
  console.log(JSON.stringify({ result: "pass", report: resolve(reportDirectory, "report.json"), evidence }));
} catch (error) {
  if (rdpPort) evidence.pageDiagnostics = await mobileDiagnostics(rdpPort).catch(() => undefined);
  evidence.failures.push(String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s]+/gi, "<url-redacted>"));
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(resolve(reportDirectory, "report.json"), `${JSON.stringify({ result: "fail", generatedAt: new Date().toISOString(), device, avd, startedEmulator, site: new URL(site.url).host + new URL(site.url).pathname, evidence }, null, 2)}\n`);
  console.error(JSON.stringify({ result: "fail", report: resolve(reportDirectory, "report.json"), failures: evidence.failures }));
  process.exitCode = 1;
} finally {
  webExtProcess?.kill("SIGINT");
  await adbCommand(["shell", "am", "force-stop", bridgePackage]).catch(() => undefined);
  await adbCommand(["shell", "am", "force-stop", vlcPackage]).catch(() => undefined);
  if (startedEmulator && process.env.KEEP_ANDROID_EMULATOR !== "1") {
    await adbCommand(["emu", "kill"]).catch(() => undefined);
    emulatorProcess?.kill("SIGTERM");
  } else if (startedEmulator) {
    emulatorProcess?.stdout?.destroy();
    emulatorProcess?.stderr?.destroy();
    emulatorProcess?.unref();
  }
}

process.exit(process.exitCode || 0);
