import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { projectVersion, root } from "./release-utils.mjs";

const exec = promisify(execFile);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(homedir(), "Android/Sdk");
const platform = resolve(sdk, "platforms/android-36/android.jar");
await stat(platform).catch(() => { throw new Error(`Android API 36 is required at ${platform}`); });
const buildTools = (await readdir(resolve(sdk, "build-tools"))).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1);
if (!buildTools) throw new Error("Android build-tools are not installed.");
const tool = (name) => resolve(sdk, "build-tools", buildTools, name);
const source = resolve(root, "android/vlc-bridge");
const temporary = resolve(root, ".tmp/android-bridge");
const classes = resolve(temporary, "classes");
const dex = resolve(temporary, "dex");
const artifacts = resolve(root, "artifacts");
const version = await projectVersion();
const versionCode = version.split(".").reduce((value, part) => value * 100 + Number(part), 0);
await rm(temporary, { recursive: true, force: true });
await mkdir(classes, { recursive: true });
await mkdir(dex, { recursive: true });
await mkdir(artifacts, { recursive: true });

const javaSources = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name.endsWith(".java")) javaSources.push(path);
  }
}
await collect(resolve(source, "src"));

const unsigned = resolve(temporary, "unsigned.apk");
await exec(tool("aapt2"), [
  "link", "-I", platform, "--manifest", resolve(source, "AndroidManifest.xml"),
  "--min-sdk-version", "26", "--target-sdk-version", "36",
  "--version-code", String(versionCode), "--version-name", version, "-o", unsigned
]);
await exec("javac", ["-source", "17", "-target", "17", "-classpath", platform, "-d", classes, ...javaSources]);

const classFiles = [];
async function collectClasses(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectClasses(path);
    else if (entry.name.endsWith(".class")) classFiles.push(path);
  }
}
await collectClasses(classes);
await exec(tool("d8"), ["--lib", platform, "--output", dex, ...classFiles]);
await exec("zip", ["-q", "-r", unsigned, "classes.dex"], { cwd: dex });

const aligned = resolve(temporary, "aligned.apk");
await exec(tool("zipalign"), ["-f", "4", unsigned, aligned]);
let keystore = process.env.ANDROID_BRIDGE_KEYSTORE;
let alias = process.env.ANDROID_BRIDGE_KEY_ALIAS;
let storePassword = process.env.ANDROID_BRIDGE_KEYSTORE_PASSWORD;
let keyPassword = process.env.ANDROID_BRIDGE_KEY_PASSWORD;
let suffix = "";
if (!keystore || !alias || !storePassword || !keyPassword) {
  suffix = "-debug";
  keystore = resolve(root, ".tmp/android-bridge-debug.keystore");
  alias = "androiddebugkey";
  storePassword = "android";
  keyPassword = "android";
  const exists = await stat(keystore).then(() => true, () => false);
  if (!exists) await exec("keytool", [
    "-genkeypair", "-keystore", keystore, "-storepass", storePassword,
    "-alias", alias, "-keypass", keyPassword, "-dname", "CN=StreamBridge Debug,O=StreamBridge,C=US",
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000"
  ]);
}
const output = resolve(artifacts, `streambridge-v${version}-vlc-bridge${suffix}.apk`);
await exec(tool("apksigner"), [
  "sign", "--ks", keystore, "--ks-pass", `pass:${storePassword}`, "--key-pass", `pass:${keyPassword}`,
  "--ks-key-alias", alias, "--out", output, aligned
]);
await exec(tool("apksigner"), ["verify", "--verbose", output]);
console.log(`Created ${output}`);
