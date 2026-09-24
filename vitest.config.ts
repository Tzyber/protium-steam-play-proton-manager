import { mergeConfig } from "vitest/config";
import shared from "./vitest.shared.js";

export default mergeConfig(shared, {
  test: { include: ["tests/**/*.test.ts"] },
});
