import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
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
    JSON.stringify({ name: "openbindings-packed-smoke", private: true, type: "module" }, null, 2),
  );

  const packageNames = packages.map(([name]) => name);
  writeFileSync(
    join(temporary, "import-smoke.mjs"),
    `for (const name of ${JSON.stringify(packageNames)}) {
  const exports = await import(name);
  if (Object.keys(exports).length === 0) throw new Error(\`\${name} has no ESM exports\`);
}
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

  run("pnpm", ["add", ...tarballs], temporary);
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
