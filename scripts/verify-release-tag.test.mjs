import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseTag } from "./verify-release-tag.mjs";

const packages = [
  { name: "@openbindings/sdk", version: "0.2.0" },
  { name: "@openbindings/openapi", version: "0.2.0" },
  { name: "example", version: "9.9.9", private: true },
];

test("accepts an exact lockstep release tag", () => {
  assert.deepEqual(verifyReleaseTag("v0.2.0", packages), []);
});

test("rejects malformed or overly broad tag names", () => {
  assert.match(verifyReleaseTag("v0.2", packages)[0], /exact SemVer/);
  assert.match(verifyReleaseTag("release-v0.2.0", packages)[0], /exact SemVer/);
});

test("reports every publishable package that disagrees with the tag", () => {
  const errors = verifyReleaseTag("v0.2.1", packages);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /@openbindings\/sdk/);
  assert.match(errors[1], /@openbindings\/openapi/);
});
