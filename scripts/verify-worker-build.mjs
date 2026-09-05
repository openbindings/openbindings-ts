import { build } from "esbuild";

const result = await build({
  stdin: {
    contents: `
      import {
        OpenBindingsRuntime,
        OperationInvoker,
        operationRequirement,
        operationSignature,
        resolveOperationRequirement,
      } from "@openbindings/sdk";
      import {
        OpenAPIAdapter,
        OpenAPIInvoker,
        OpenAPISynthesizer,
      } from "@openbindings/openapi";

      export default {
        async fetch() {
          const required = {
            openbindings: "0.2.0",
            operations: { ping: { output: { type: "string" } } },
          };
          const requirement = operationRequirement(
            required,
            operationSignature("ping"),
          );
          void requirement;
          void resolveOperationRequirement;
          void new OpenBindingsRuntime({ providers: [new OpenAPIAdapter()] });
          void new OperationInvoker([new OpenAPIInvoker()]);
          void new OpenAPISynthesizer();
          return new Response("worker-ready");
        },
      };
    `,
    // Resolve through a real workspace consumer, rather than relying on the
    // private workspace root to declare every publishable package.
    resolveDir: `${process.cwd()}/examples/react-operation-dependencies`,
    sourcefile: "worker-smoke.ts",
    loader: "ts",
  },
  bundle: true,
  conditions: ["worker", "browser", "module"],
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});

const source = result.outputFiles.map(file => file.text).join("\n");
const forbidden = [
  /(?:from|import\()\s*["']node:/,
  /(?:from|import\()\s*["'](?:fs|path|url)(?:\/promises)?["']/,
  /\brequire\(["'](?:node:|fs|path|url)/,
];

for (const pattern of forbidden) {
  if (pattern.test(source)) {
    throw new Error(`Worker bundle contains a Node dependency matching ${pattern}`);
  }
}

console.log(`Worker bundle clean: ${source.length} bytes before minification`);
