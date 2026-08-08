#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function verifyReleaseTag(tag, manifests) {
  const errors = [];
  if (!SEMVER_TAG.test(tag)) {
    errors.push(`release tag must be exact SemVer in vX.Y.Z form, got ${JSON.stringify(tag)}`);
    return errors;
  }

  const expected = tag.slice(1);
  const publishable = manifests.filter((manifest) => manifest.private !== true);
  if (publishable.length === 0) errors.push("no publishable packages found under packages/");
  for (const manifest of publishable) {
    if (manifest.version !== expected) {
      errors.push(`${manifest.name ?? "<unnamed>"}: version ${JSON.stringify(manifest.version)} does not match tag ${tag}`);
    }
  }
  return errors;
}

async function loadPackageManifests(root) {
  const packagesDir = path.join(root, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.join(packagesDir, entry.name, "package.json");
    try {
      manifests.push(JSON.parse(await readFile(packagePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return manifests;
}

async function main() {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error("release tag is required via --tag or GITHUB_REF_NAME");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = verifyReleaseTag(tag, await loadPackageManifests(root));
  if (errors.length > 0) {
    for (const error of errors) console.error(`release preflight: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`release preflight: every publishable package matches ${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
