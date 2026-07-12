import assert from "node:assert/strict";
import test from "node:test";
import { sniffContainer, validationIsFresh } from "../../src/core/validator";
import type { StreamCandidate } from "../../src/shared/types";

test("recognizes portable containers and rejects image signatures", () => {
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), "mp4");
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 24, 0x73, 0x74, 0x79, 0x70])), "fmp4-fragment");
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 24, 0x6d, 0x6f, 0x6f, 0x66])), "fmp4-fragment");
  assert.equal(sniffContainer(Uint8Array.from([0x47, 0, 0, 0])), "mpeg-ts");
  assert.equal(sniffContainer(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), "webm");
  assert.equal(sniffContainer(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image");
});

test("portable validation expires", () => {
  const candidate = { validationStatus: "playable", validatedAt: 1000 } as StreamCandidate;
  assert.equal(validationIsFresh(candidate, 2000), true);
  assert.equal(validationIsFresh(candidate, 10 * 60 * 1000), false);
});
