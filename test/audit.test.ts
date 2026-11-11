/** Findings of the router-data audit: each test asserts what the code returns. */
import { describe, expect, it } from "vitest";
import { structuralShare } from "../src/share";

describe("structural sharing keeps the shape of the new data", () => {
  it("[QRY-A1] an array whose length differs only by trailing holes keeps its new length", () => {
    const next = new Array<number>(5);
    expect(structuralShare([], next)).toHaveLength(5);
    const kept = [1];
    const longer = new Array<number>(3);
    longer[0] = 1;
    expect(structuralShare(kept, longer)).toHaveLength(3);
  });
});
