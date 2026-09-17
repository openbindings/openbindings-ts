import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/advanced.ts", "src/internal.ts", "src/values.ts"],
  format: ["esm", "cjs"],
  // CJS splitting keeps one module-private runtime (leaf classes, the
  // authentication registry, counters) across the four CJS entries.
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
});
