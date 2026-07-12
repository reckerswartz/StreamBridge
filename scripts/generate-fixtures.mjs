import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".tmp/fixtures");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await new Promise((resolveCommand, reject) => {
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100",
    "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", resolve(output, "sample.mp4")
  ], { stdio: "inherit" });
  child.on("exit", (code) => code === 0 ? resolveCommand() : reject(new Error(`ffmpeg exited ${code}`)));
  child.on("error", reject);
});

await new Promise((resolveCommand, reject) => {
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", resolve(output, "sample.mp4"),
    "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "700k",
    "-c:a", "libopus", resolve(output, "sample.webm")
  ], { stdio: "inherit" });
  child.on("exit", (code) => code === 0 ? resolveCommand() : reject(new Error(`ffmpeg exited ${code}`)));
  child.on("error", reject);
});

await new Promise((resolveCommand, reject) => {
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", resolve(output, "sample.mp4"),
    "-c", "copy", "-hls_time", "3", "-hls_playlist_type", "vod",
    "-hls_segment_filename", resolve(output, "segment-%02d.ts"), resolve(output, "media.m3u8")
  ], { stdio: "inherit" });
  child.on("exit", (code) => code === 0 ? resolveCommand() : reject(new Error(`ffmpeg exited ${code}`)));
  child.on("error", reject);
});

await writeFile(resolve(output, "master.m3u8"), `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
media.m3u8
`);

console.log(`Generated fixtures in ${output}`);
