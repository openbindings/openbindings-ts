// The built package must be one installation whichever way Node loads it:
// import and require, and the root, advanced and internal entries. This runs
// against dist in a plain Node process (no test-runner alias), so it fails
// when dist is missing or was built without the CJS split or the ESM bridges.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = `
import * as esm from "@openbindings/json";
import { access, external } from "@openbindings/json/advanced";
import { isAuthenticated } from "@openbindings/json/internal";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cjs = require("@openbindings/json"), cjsAdvanced = require("@openbindings/json/advanced"), cjsInternal = require("@openbindings/json/internal");
console.log(JSON.stringify({
  esmSeesRequireDecimal: esm.isDecimal(cjs.number("0.3")),
  requireSeesEsmDecimal: cjs.isDecimal(esm.number("0.3")),
  esmSeesRequireEncoded: esm.isEncoded(cjs.base64(Uint8Array.of(1))),
  base64Identity: esm.BASE64 === cjs.BASE64,
  esmRegistrySeesRequireOutput: isAuthenticated(cjsAdvanced.external({ a: 1 }, cjsAdvanced.access)),
  requireRegistrySeesEsmOutput: cjsInternal.isAuthenticated(external({ a: 1 }, access)),
  valueErrorIdentity: esm.ValueError === cjs.ValueError,
}));
`;

it("import and require of the root, advanced and internal entries share one installation", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(output.trim().split("\n").pop()!) as Record<string, boolean>;
  for (const [name, value] of Object.entries(result)) expect(value, name).toBe(true);
});
