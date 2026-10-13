import { describe, expect, it } from "vitest";
import { ensureSizeLimit, MAX_FILE_BYTES } from "./fakeSteam.js";

describe("ensureSizeLimit (M4.3, größen-cap für reads)", () => {
  it("unter dem limit → kein throw", () => {
    expect(() => ensureSizeLimit(1024)).not.toThrow();
    expect(() => ensureSizeLimit(MAX_FILE_BYTES)).not.toThrow();
  });

  it("über dem limit → wirft", () => {
    expect(() => ensureSizeLimit(MAX_FILE_BYTES + 1)).toThrow(/zu groß/);
  });
});
