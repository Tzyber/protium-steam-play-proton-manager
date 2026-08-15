import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    include: ["tests/benchmarks/**/*.bench.ts"],
    testTimeout: 30_000,
  },
});
