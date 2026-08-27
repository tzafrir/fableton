import { describe, expect, it } from "vitest";
import { sampleOffsetForBlock } from "./scheduling";

const SR = 48000;
const BLOCK = 128;
const BLOCK_SECONDS = BLOCK / SR;

describe("sampleOffsetForBlock", () => {
  it("clamps a `when` at or before the block start to offset 0", () => {
    expect(sampleOffsetForBlock(1.0, 1.0, SR, BLOCK)).toBe(0);
    expect(sampleOffsetForBlock(0.5, 1.0, SR, BLOCK)).toBe(0);
  });

  it("returns null for a `when` beyond the end of this block", () => {
    expect(sampleOffsetForBlock(1.0 + BLOCK_SECONDS + 0.001, 1.0, SR, BLOCK)).toBeNull();
  });

  it("computes the exact sample offset inside the block", () => {
    const halfway = 1.0 + BLOCK_SECONDS / 2;
    const offset = sampleOffsetForBlock(halfway, 1.0, SR, BLOCK);
    expect(offset).toBe(Math.round((BLOCK / 2) * 1)); // BLOCK/2 samples in
  });

  it("the last sample of the block is included, the one after is not", () => {
    const lastSampleTime = 1.0 + (BLOCK - 1) / SR;
    expect(sampleOffsetForBlock(lastSampleTime, 1.0, SR, BLOCK)).toBe(BLOCK - 1);
    const oneBlockLater = 1.0 + BLOCK / SR;
    expect(sampleOffsetForBlock(oneBlockLater, 1.0, SR, BLOCK)).toBeNull();
  });

  it("treats a non-finite `when` as immediately due", () => {
    expect(sampleOffsetForBlock(Number.NaN, 1.0, SR, BLOCK)).toBe(0);
  });
});
