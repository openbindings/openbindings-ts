import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/jsonata.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
