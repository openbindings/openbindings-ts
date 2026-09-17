import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The case table imports the package by its public specifier; resolve it to
// the source entry so the table runs without a build. From the workspace root,
// where this config does not apply, the same specifier resolves to the built
// dist. Either way @openbindings/json is the one installed dist, so the
// validator and the table's leaves share one installation.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@openbindings\/json-schema$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
});
