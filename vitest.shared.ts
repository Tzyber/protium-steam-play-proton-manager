import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// Gemeinsame Basis der beiden vitest-configs (test und bench): vue-plugin und
// globals waren dupliziert und konnten driften. Ein coverage-Block fehlt
// bewusst: die Coverage-Bibliothek ist nicht installiert, eine neue dependency
// wäre scope-creep (AGENTS.md), und ohne gemessenen IST-Stand wäre jede
// Schwelle geraten (G-05).
export default defineConfig({
  plugins: [vue()],
  test: { globals: true },
});
