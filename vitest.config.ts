import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Existing assertions read French messages; English output has its own tests.
    env: { CUTKILLER_LANG: "fr" },
  },
});
