import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectToFirefox } from "../node_modules/web-ext/lib/firefox/rdp-client.js";
import { enableFirefoxRemoteDebugging } from "./android-firefox-ui.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const adb = process.env.ADB_BIN || "/home/recker/Android/Sdk/platform-tools/adb";
const emulatorBinary = process.env.EMULATOR_BIN || "/home/recker/Android/Sdk/emulator/emulator";
const device = process.env.ADB_DEVICE || "emulator-5554";
const avd = process.env.ANDROID_AVD || "tnfr_uat_api36";
const firefoxPackage = process.env.FIREFOX_PACKAGE || "org.mozilla.firefox";
const tabLimit = Number(process.env.STRESS_TABS || 15);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = resolve(root, process.env.STRESS_REPORT_DIR || `.tmp/stress/${stamp}`);
const snapshots = [];
let emulatorProcess;
let webExtProcess;

function sleep(milliseconds) { return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)); }
function withTimeout(promise, label, milliseconds = 15_000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds))]);
}
async function adbCommand(args, options = {}) { return exec(adb, ["-s", device, ...args], { maxBuffer: 20 * 1024 * 1024, ...options }); }

async function ensureEmulator() {
  const devices = await exec(adb, ["devices"]);
  if (devices.stdout.includes(`${device}\tdevice`)) return false;
  emulatorProcess = spawn(emulatorBinary, ["-avd", avd, "-no-window", "-gpu", "swiftshader_indirect", "-no-snapshot-load", "-no-audio", "-no-boot-anim"], { stdio: ["ignore", "pipe", "pipe"] });
  await exec(adb, ["wait-for-device"]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { stdout } = await adbCommand(["shell", "getprop", "sys.boot_completed"]).catch(() => ({ stdout: "" }));
    if (stdout.trim() === "1") return true;
    await sleep(2000);
  }
  throw new Error("Android emulator did not finish booting.");
}

async function startFixtureServer() {
  try { if ((await fetch("http://127.0.0.1:8765/fixture")).ok) return null; } catch { /* start below */ }
  const child = spawn(process.execPath, [resolve(root, "scripts/fixture-server.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    try { if ((await fetch("http://127.0.0.1:8765/fixture")).ok) return child; } catch { /* retry */ }
  }
  child.kill("SIGTERM");
  throw new Error("Fixture server did not start.");
}

async function installExtension() {
  return new Promise((resolveInstall, rejectInstall) => {
    const child = spawn("npx", ["web-ext", "run", "--source-dir", "dist/firefox", "--target", "firefox-android", "--adb-bin", adb, "--adb-device", device, "--firefox-apk", firefoxPackage, "--no-reload", "--adb-remove-old-artifacts"], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
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
    child.on("exit", (code) => { if (code && !output.includes("Installed")) { clearTimeout(timer); rejectInstall(new Error(`web-ext exited ${code}: ${output.slice(-500)}`)); } });
  });
}

async function dismissInstallPrompt() {
  await adbCommand(["shell", "uiautomator", "dump", "/sdcard/streambridge-window.xml"]).catch(() => undefined);
  const { stdout } = await adbCommand(["shell", "cat", "/sdcard/streambridge-window.xml"]).catch(() => ({ stdout: "" }));
  const match = stdout.match(/text="OK"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!match) return;
  const x = Math.round((Number(match[1]) + Number(match[3])) / 2);
  const y = Math.round((Number(match[2]) + Number(match[4])) / 2);
  await adbCommand(["shell", "input", "tap", String(x), String(y)]);
}

async function evaluateAddon(port, expression) {
  const discovery = await withTimeout(connectToFirefox(port), "Firefox RDP connection");
  const addons = await withTimeout(discovery.request("listAddons"), "Firefox add-on listing");
  const addon = addons.addons.find((item) => item.id === "streambridge@reckerswartz.github.io");
  if (!addon) throw new Error("StreamBridge temporary add-on is not installed.");
  const extensionBase = new URL(".", addon.manifestURL).href;
  await adbCommand(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `http://127.0.0.1:8765/fixture?diagnostic=${Date.now()}`, firefoxPackage]);
  await sleep(500);
  const visibleTabs = await withTimeout(discovery.request("listTabs"), "Firefox tab listing");
  if (!visibleTabs.tabs[0]) throw new Error("Firefox did not expose a navigable tab.");
  void discovery.request({ to: visibleTabs.tabs[0].actor, type: "navigateTo", url: `${extensionBase}popup/index.html?stress=1`, waitForLoad: false }).catch(() => undefined);
  await sleep(1000);
  discovery.disconnect();
  const client = await withTimeout(connectToFirefox(port), "Firefox diagnostics connection");
  const evaluations = [];
  const capture = (error) => {
    const match = error.message.match(/Unexpected RDP message received: (\{.*\})$/s);
    if (!match) return;
    const message = JSON.parse(match[1]);
    if (message.type === "evaluationResult") evaluations.push(message);
  };
  client.on("error", capture);
  try {
    const tabs = await withTimeout(client.request("listTabs"), "Firefox diagnostics tab listing");
    const extensionTab = tabs.tabs.find((item) => item.url.startsWith(extensionBase)) || tabs.tabs[0];
    if (!extensionTab) throw new Error("Firefox did not expose the extension diagnostics tab.");
    const target = await withTimeout(client.request({ to: extensionTab.actor, type: "getTarget" }), "Firefox diagnostics target");
    const scheduled = `globalThis.__streamBridgeStressResult=undefined;Promise.resolve(${expression}).then(value=>globalThis.__streamBridgeStressResult=value,error=>globalThis.__streamBridgeStressResult=JSON.stringify({error:String(error)}));'scheduled'`;
    await withTimeout(client.request({ to: target.frame.consoleActor, type: "evaluateJSAsync", text: scheduled }), "Firefox diagnostics scheduling");
    for (let attempt = 0; attempt < 20 && evaluations.length < 1; attempt += 1) await sleep(100);
    await sleep(500);
    const previousCount = evaluations.length;
    await withTimeout(client.request({ to: target.frame.consoleActor, type: "evaluateJSAsync", text: "globalThis.__streamBridgeStressResult" }), "Firefox diagnostics readback");
    for (let attempt = 0; attempt < 20 && evaluations.length <= previousCount; attempt += 1) await sleep(100);
    const evaluation = evaluations.at(-1);
    if (!evaluation) throw new Error("Firefox did not return the extension evaluation result.");
    if (evaluation.hasException) throw new Error(String(evaluation.exception || "Extension evaluation failed."));
    return evaluation.result && typeof evaluation.result === "object" && "value" in evaluation.result ? evaluation.result.value : evaluation.result;
  } finally { client.disconnect(); }
}

function decodeEvaluation(value) {
  if (typeof value === "string") return JSON.parse(value);
  if (value && typeof value === "object") return value;
  throw new Error("Firefox returned an invalid diagnostics result.");
}

async function resetTabs(port) {
  const expression = `(async()=>{const tabs=await browser.tabs.query({});const current=await browser.tabs.getCurrent();const remove=tabs.filter(tab=>tab.id!==current.id).map(tab=>tab.id);if(remove.length)await browser.tabs.remove(remove);setTimeout(()=>browser.tabs.update(current.id,{url:'about:blank',active:true}),1500);return JSON.stringify({before:tabs.length,after:1})})()`;
  return decodeEvaluation(await evaluateAddon(port, expression));
}

async function extensionState(port) {
  const expression = `(async()=>{const current=await browser.tabs.getCurrent();const tabs=await browser.tabs.query({});const all=await browser.storage.session.get(null);const streamKeys=Object.keys(all).filter(key=>key.startsWith('streams:'));setTimeout(()=>browser.tabs.remove(current.id),1500);return JSON.stringify({tabs:tabs.filter(tab=>tab.id!==current.id).length,streamKeys:streamKeys.length,serializedBytes:new TextEncoder().encode(JSON.stringify(all)).length,candidateTotal:streamKeys.reduce((sum,key)=>sum+(Array.isArray(all[key])?all[key].length:0),0)})})()`;
  return decodeEvaluation(await evaluateAddon(port, expression));
}

async function memorySnapshot(label, port) {
  const { stdout } = await adbCommand(["shell", "dumpsys", "meminfo", firefoxPackage]);
  const totalLine = stdout.match(/TOTAL PSS:\s*(\d+).*TOTAL RSS:\s*(\d+)/);
  const tableTotal = stdout.match(/^\s*TOTAL\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/m);
  const pssKiB = Number(totalLine?.[1] || tableTotal?.[1] || 0);
  const rssKiB = Number(totalLine?.[2] || tableTotal?.[2] || 0);
  let state = await extensionState(port);
  if (state?.error) { await sleep(750); state = await extensionState(port); }
  snapshots.push({ label, at: new Date().toISOString(), pssKiB, rssKiB, extension: state });
}

async function openUrl(url) {
  await adbCommand(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, firefoxPackage]);
  await sleep(1200);
  const { stdout } = await adbCommand(["shell", "wm", "size"]);
  const dimensions = stdout.match(/(?:Physical|Override) size:\s*(\d+)x(\d+)/i);
  const width = Number(dimensions?.[1] || 1080);
  const height = Number(dimensions?.[2] || 1920);
  // A real tap is required because StreamBridge intentionally ignores passive
  // autoplay and programmatic fetches. Tap well below the fixture video so the
  // document is activated without pausing its muted playback.
  await adbCommand(["shell", "input", "tap", String(Math.round(width * 0.08)), String(Math.round(height * 0.65))]);
  // The first tap can race a cold Gecko content process even after Android has
  // handed the URL to Firefox. A second harmless document tap makes activation
  // deterministic without scripting the fixture or bypassing the trusted-event gate.
  await sleep(1200);
  await adbCommand(["shell", "input", "tap", String(Math.round(width * 0.08)), String(Math.round(height * 0.65))]);
  await sleep(1800);
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else {
    child.kill("SIGTERM");
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

let fixtureServer;
try {
  console.log(JSON.stringify({ stage: "android-start", device, avd, tabLimit }));
  const startedEmulator = await ensureEmulator();
  console.log(JSON.stringify({ stage: "android-booted", startedEmulator }));
  fixtureServer = await startFixtureServer();
  await adbCommand(["reverse", "tcp:8765", "tcp:8765"]);
  await adbCommand(["logcat", "-c"]);
  await enableFirefoxRemoteDebugging({ adb, device, firefoxPackage, diagnosticsDirectory: reportDirectory });
  console.log(JSON.stringify({ stage: "firefox-debugging-enabled" }));
  const port = await installExtension();
  console.log(JSON.stringify({ stage: "extension-installed", port }));
  await sleep(1500);
  await dismissInstallPrompt();
  await resetTabs(port);
  await memorySnapshot("baseline", port);
  console.log(JSON.stringify({ stage: "baseline", snapshot: snapshots.at(-1) }));
  for (let index = 1; index <= tabLimit; index += 1) {
    await openUrl(`http://127.0.0.1:8765/stress/control/${index}?activate=1`);
    if ([5, 10, 15].includes(index)) {
      await memorySnapshot(`open-${index}`, port);
      console.log(JSON.stringify({ stage: `open-${index}`, snapshot: snapshots.at(-1) }));
    }
  }
  await sleep(8000);
  await memorySnapshot(`capture-${tabLimit}`, port);
  console.log(JSON.stringify({ stage: `capture-${tabLimit}`, snapshot: snapshots.at(-1) }));
  for (let second = 5; second <= 60; second += 5) {
    await sleep(5000);
    if (second % 15 === 0) {
      await memorySnapshot(`steady-${second}`, port);
      console.log(JSON.stringify({ stage: `steady-${second}`, snapshot: snapshots.at(-1) }));
    }
  }
  await resetTabs(port);
  await sleep(10_000); await memorySnapshot("cleanup-10", port);
  await sleep(20_000); await memorySnapshot("cleanup-30", port);
  await sleep(30_000); await memorySnapshot("cleanup-60", port);
  const { stdout: rawLog } = await adbCommand(["logcat", "-d", "-v", "threadtime"]);
  const filteredLog = rawLog.split("\n").filter((line) => /Firefox|Gecko|WebExtension|StreamBridge|ActivityManager|lowmemory|ANR|crash|breakpad/i.test(line)).join("\n")
    .replace(/(token=)[^&\s]+/gi, "$1[REDACTED]").replace(/https?:\/\/[^\s]+/gi, "<url-redacted>");
  await mkdir(reportDirectory, { recursive: true });
  const baseline = snapshots.find((item) => item.label === "baseline");
  const cleanup = snapshots.find((item) => item.label === "cleanup-60");
  const failures = [];
  const peakCandidates = Math.max(0, ...snapshots.map((item) => item.extension.candidateTotal || 0));
  if (peakCandidates < Math.min(10, tabLimit)) failures.push("Firefox qualified fewer than the required activated fixture streams.");
  if (cleanup.extension.streamKeys !== 0) failures.push("Firefox retained extension stream keys after cleanup.");
  if (cleanup.pssKiB > baseline.pssKiB + Math.max(150 * 1024, baseline.pssKiB * 0.2)) failures.push("Firefox PSS did not recover within the Android budget.");
  if (/ActivityManager: ANR in org\.mozilla\.firefox|FATAL EXCEPTION[^\n]*org\.mozilla\.firefox|google-breakpad:[^\n]*GenerateDump/i.test(filteredLog)) {
    failures.push("Firefox or a child process crashed during the Android campaign.");
  }
  const report = { suite: "android-control", device, avd, startedEmulator, tabLimit, peakCandidates, snapshots, failures };
  const jsonPath = resolve(reportDirectory, "android-control.json");
  const logPath = resolve(reportDirectory, "android-firefox.log");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(logPath, `${filteredLog}\n`);
  console.log(JSON.stringify({ result: failures.length ? "fail" : "pass", failures, reports: { jsonPath, logPath } }));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  await mkdir(reportDirectory, { recursive: true });
  const errorPath = resolve(reportDirectory, "android-control-partial.json");
  await writeFile(errorPath, `${JSON.stringify({ suite: "android-control", device, avd, snapshots, error: String(error) }, null, 2)}\n`);
  console.error(JSON.stringify({ result: "error", error: String(error), report: errorPath }));
  process.exitCode = 1;
} finally {
  stopProcessTree(webExtProcess);
  stopProcessTree(fixtureServer);
  if (emulatorProcess) {
    await adbCommand(["emu", "kill"]).catch(() => undefined);
    emulatorProcess.kill("SIGTERM");
  }
}
