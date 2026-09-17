import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The case table imports the package by its public specifiers; resolve every
// entry it uses to the source modules so the table runs without a build and
// all three entries are one installation. From the workspace root, where this
// config does not apply, the same specifiers resolve to the built dist, again
// one installation, so both invocations agree.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@openbindings\/json\/advanced$/, replacement: fileURLToPath(new URL("./src/advanced.ts", import.meta.url)) },
      { find: /^@openbindings\/json\/internal$/, replacement: fileURLToPath(new URL("./src/internal.ts", import.meta.url)) },
      { find: /^@openbindings\/json$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
});
