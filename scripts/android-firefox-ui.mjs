import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nodeBounds(xml, attribute, value) {
  const match = xml.match(new RegExp(`${attribute}="${escapePattern(value)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, "i"));
  if (!match) return null;
  return {
    x: Math.round((Number(match[1]) + Number(match[3])) / 2),
    y: Math.round((Number(match[2]) + Number(match[4])) / 2)
  };
}

export async function enableFirefoxRemoteDebugging(options) {
  const { adb, device, firefoxPackage, diagnosticsDirectory } = options;
  const adbCommand = (args, commandOptions = {}) => exec(adb, ["-s", device, ...args], { maxBuffer: 20 * 1024 * 1024, ...commandOptions });
  const sizeOutput = (await adbCommand(["shell", "wm", "size"])).stdout;
  const sizes = [...sizeOutput.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gi)];
  const screenWidth = Number(sizes.at(-1)?.[1] || 1080);
  const screenHeight = Number(sizes.at(-1)?.[2] || 1920);
  const dump = async () => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await adbCommand(["shell", "uiautomator", "dump", "/sdcard/streambridge-firefox.xml"]);
        return (await adbCommand(["shell", "cat", "/sdcard/streambridge-firefox.xml"])).stdout;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    throw lastError;
  };
  const tap = async (bounds) => {
    await adbCommand(["shell", "input", "tap", String(bounds.x), String(bounds.y)]);
    await sleep(700);
  };
  const locate = (xml, value) => nodeBounds(xml, "text", value) || nodeBounds(xml, "content-desc", value);
  const locateAny = (xml, values) => values.map((value) => locate(xml, value)).find(Boolean);
  const enabledIn = (value) => /resource-id="[^"]*(?:switchWidget|switch_widget)"[^>]*checked="true"/i.test(value);
  const verifyEnabled = async (value) => {
    if (!enabledIn(value)) throw new Error("Firefox Remote debugging via USB did not stay enabled.");
    const sockets = (await adbCommand(["shell", "cat", "/proc/net/unix"])).stdout;
    if (!sockets.includes(`${firefoxPackage}/firefox-debugger-socket`)) {
      throw new Error("Firefox enabled the setting but did not open its debugger socket.");
    }
    if (diagnosticsDirectory) {
      await mkdir(diagnosticsDirectory, { recursive: true });
      await writeFile(resolve(diagnosticsDirectory, "firefox-debugging-enabled.xml"), value);
    }
  };

  await adbCommand(["shell", "monkey", "-p", firefoxPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
  await sleep(2_000);

  let xml = await dump();
  const visibleSetting = locate(xml, "Remote debugging via USB");
  if (visibleSetting && /resource-id="[^"]*(?:switchWidget|switch_widget)"/i.test(xml)) {
    if (!enabledIn(xml)) {
      await tap(visibleSetting);
      xml = await dump();
    }
    await verifyEnabled(xml);
    return;
  }
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (locateAny(xml, ["More options", "Menu"])) break;
    const next = ["Not now", "Cancel", "Continue", "Save and continue", "Skip", "Start browsing", "Finish", "Done", "OK", "Got it"]
      .map((label) => locate(xml, label))
      .find(Boolean);
    if (!next) {
      await sleep(700);
      continue;
    }
    await tap(next);
    xml = await dump();
  }

  const menu = locateAny(xml || await dump(), ["More options", "Menu"]);
  if (!menu) throw new Error("Firefox onboarding did not reach the browser toolbar.");
  await tap(menu);
  xml = await dump();
  const settings = locate(xml, "Settings");
  if (!settings) throw new Error("Firefox menu did not expose Settings.");
  await tap(settings);
  xml = await dump();

  const search = locate(xml, "Settings search button");
  if (search) {
    await tap(search);
    await adbCommand(["shell", "input", "text", "remote"]);
    await sleep(1_000);
    xml = await dump();
    const result = locate(xml, "Remote debugging via USB");
    if (!result) throw new Error("Firefox settings search did not find Remote debugging via USB.");
    await tap(result);
    xml = await dump();
  }

  let remoteDebugging = locate(xml, "Remote debugging via USB");
  for (let attempt = 0; !remoteDebugging && attempt < 12; attempt += 1) {
    const x = String(Math.round(screenWidth * 0.5));
    await adbCommand(["shell", "input", "swipe", x, String(Math.round(screenHeight * 0.85)), x, String(Math.round(screenHeight * 0.25)), "350"]);
    await sleep(500);
    xml = await dump();
    remoteDebugging = locate(xml, "Remote debugging via USB");
  }
  if (!remoteDebugging) throw new Error("Firefox settings did not expose Remote debugging via USB.");
  if (!enabledIn(xml)) {
    await tap(remoteDebugging);
    xml = await dump();
  }
  await verifyEnabled(xml);
}
