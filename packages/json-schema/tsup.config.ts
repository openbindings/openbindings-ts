import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // The pinned, qualified validator correction must travel in the artifact.
  // Consumers neither install our workspace patch nor depend on its backend.
  noExternal: ["json-schema-library"],
});
