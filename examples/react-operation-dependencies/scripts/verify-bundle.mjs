import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const assetDir = resolve("dist", "assets");
const files = (await readdir(assetDir)).filter(file => file.endsWith(".js"));
const source = (
  await Promise.all(files.map(file => readFile(resolve(assetDir, file), "utf8")))
).join("\n");

const forbidden = [
  "openbindings.asyncapi@1",
  "openbindings.graphql@1",
  "openbindings.graphql@1",
  "openbindings.grpc@1",
  "openbindings.connect@1",
  "openbindings.mcp@1",
  "openbindings.mcp@1",
  "openbindings.usage@1",
  "node:fs",
  "node:path",
  "node:url",
];

for (const token of forbidden) {
  if (source.includes(token)) {
    throw new Error(`browser fixture unexpectedly contains ${token}`);
  }
}

console.log(
  `React fixture JavaScript: ${source.length} bytes raw, ${gzipSync(source).length} bytes gzip`,
);
