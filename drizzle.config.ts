import { defineConfig } from "drizzle-kit";

// Generate only: migrations are applied with `wrangler d1 migrations apply DB` (NFR-6: the only schema-change path)
export default defineConfig({
  dialect: "sqlite",
  // Phases 4 to 6 keep their tables in their own product folder
  schema: ["./src/worker/core/db/schema.ts", "./src/worker/products/*/schema.ts"],
  out: "./drizzle",
});
