import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { classifyResponse } from "../../src/core/classifier";

test("classification remains below the 5 ms p95 budget", () => {
  const samples: number[] = [];
  for (let index = 0; index < 5000; index += 1) {
    const started = performance.now();
    classifyResponse(`https://cdn.test/video-${index}.mp4?token=fake`, "video/mp4");
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 < 5, `p95 was ${p95.toFixed(3)} ms`);
});
