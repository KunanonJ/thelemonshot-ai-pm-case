import { defineConfig } from "drizzle-kit";

// Generate only: migrations are applied with `wrangler d1 migrations apply DB` (NFR-6: the only schema-change path)
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/core/db/schema.ts",
  out: "./drizzle",
});
