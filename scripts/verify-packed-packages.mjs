import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = [
  ["@openbindings/sdk", "sdk"],
  ["@openbindings/openapi", "openapi"],
  ["@openbindings/asyncapi", "asyncapi"],
  ["@openbindings/mcp", "mcp"],
  ["@openbindings/grpc", "grpc"],
  ["@openbindings/connect", "connect"],
  ["@openbindings/usage", "usage"],
  ["@openbindings/graphql", "graphql"],
  ["@openbindings/operationgraph", "operationgraph"],
];
const temporary = mkdtempSync(join(tmpdir(), "openbindings-packed-consumer-"));
const openAPIClientDirectory = process.env.OPENBINDINGS_OPENAPI_CLIENT_DIR
  ?? join(root, "..", "openapi-client", "typescript");
const asyncAPIClientDirectory = process.env.OPENBINDINGS_ASYNCAPI_CLIENT_DIR
  ?? join(root, "..", "asyncapi-client", "typescript");

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
  if (!existsSync(join(openAPIClientDirectory, "package.json"))) {
    throw new Error(
      `standalone OpenAPI client checkout not found at ${openAPIClientDirectory}; set OPENBINDINGS_OPENAPI_CLIENT_DIR`,
    );
  }
  if (!existsSync(join(asyncAPIClientDirectory, "package.json"))) {
    throw new Error(
      `standalone AsyncAPI client checkout not found at ${asyncAPIClientDirectory}; set OPENBINDINGS_ASYNCAPI_CLIENT_DIR`,
    );
  }
  const openAPIClientTarball = join(temporary, "openapi-client.tgz");
  run("pnpm", ["--dir", openAPIClientDirectory, "pack", "--out", openAPIClientTarball]);
  const asyncAPIClientTarball = join(temporary, "asyncapi-client.tgz");
  run("pnpm", ["--dir", asyncAPIClientDirectory, "pack", "--out", asyncAPIClientTarball]);
  const tarballs = packages.map(([name, slug]) => {
    const tarball = join(temporary, `${slug}.tgz`);
    run("pnpm", ["--filter", name, "pack", "--out", tarball]);

    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    if (!entries.split("\n").includes("package/LICENSE")) {
      throw new Error(`${name} tarball does not include LICENSE`);
    }
    return tarball;
  });

  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({
      name: "openbindings-packed-smoke",
      private: true,
      type: "module",
      pnpm: {
        overrides: {
          // The standalone client is released independently. During draft
          // qualification, force the adapter's semver dependency to the
          // sibling repository's packed artifact.
          "@openbindings/openapi-client": `file:${openAPIClientTarball}`,
          "@openbindings/asyncapi-client": `file:${asyncAPIClientTarball}`,
        },
      },
    }, null, 2),
  );

  const packageNames = [
    "@openbindings/openapi-client",
    "@openbindings/asyncapi-client",
    ...packages.map(([name]) => name),
  ];
  writeFileSync(
    join(temporary, "import-smoke.mjs"),
    `for (const name of ${JSON.stringify(packageNames)}) {
  const exports = await import(name);
  if (Object.keys(exports).length === 0) throw new Error(\`\${name} has no ESM exports\`);
}
const { OpenAPIEngine } = await import("@openbindings/openapi-client/engine");
const prepared = await new OpenAPIEngine().prepare({
  source: { content: {
    openapi: "3.1.0",
    info: { title: "packed runtime", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: { "/ping": { get: { responses: {
      "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
    } } } },
  } },
  ref: "#/paths/~1ping/get",
  fetch: async input => {
    if (String(input) !== "https://api.example.test/ping") throw new Error("packed runtime planned the wrong request");
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  },
});
const execution = await prepared.start();
await execution.finishInput();
const outputs = [];
for await (const event of execution.events) outputs.push(event.value);
await execution.completed;
if (outputs[0]?.ok !== true) throw new Error("packed engine did not yield the application value");
`,
  );
  writeFileSync(
    join(temporary, "require-smoke.cjs"),
    `for (const name of ${JSON.stringify(packageNames)}) {
  const exports = require(name);
  if (Object.keys(exports).length === 0) throw new Error(\`\${name} has no CommonJS exports\`);
}
`,
  );
  writeFileSync(
    join(temporary, "types-smoke.ts"),
    readFileSync(join(root, "scripts", "packed-types-smoke.ts"), "utf8"),
  );

  // Install locally packed foundations before adapters that declare ordinary
  // semver dependencies on them. pnpm otherwise attempts to resolve a new,
  // not-yet-published sibling package from the registry while constructing a
  // single multi-tarball add transaction.
  run("pnpm", ["add", openAPIClientTarball, asyncAPIClientTarball, tarballs[0]], temporary);
  run("pnpm", ["add", ...tarballs.slice(1)], temporary);
  run(process.execPath, ["import-smoke.mjs"], temporary);
  run(process.execPath, ["require-smoke.cjs"], temporary);
  run(
    join(root, "node_modules", ".bin", "tsc"),
    [
      "--noEmit",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "types-smoke.ts",
    ],
    temporary,
  );

  console.log(`packed-package verification passed for ${packages.length} packages`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
