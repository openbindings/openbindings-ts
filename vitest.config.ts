import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // Let Node load built package entries. Re-evaluating a workspace's
        // CommonJS bundle in Vitest creates a second private value owner while
        // nested require() calls continue to use Node's actual module cache.
        external: [/\/dist\/.*\.(?:cjs|js)$/],
      },
    },
  },
});
