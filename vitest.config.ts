import { defineConfig } from "vitest/config";

// Unit tests cover the pure modules only, so they run in plain Node without the Workers runtime
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
