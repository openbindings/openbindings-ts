export const MIN_SUPPORTED_VERSION = "0.1.0";
export const MAX_TESTED_VERSION = "0.1.0";

export function supportedRange(): { min: string; max: string } {
  return { min: MIN_SUPPORTED_VERSION, max: MAX_TESTED_VERSION };
}

export function isSupportedVersion(v: string): boolean {
  const parsed = parseSemver(v);
  if (!parsed) return false;
  return compareSemver(parsed, parseSemver(MIN_SUPPORTED_VERSION)!) >= 0 &&
    compareSemver(parsed, parseSemver(MAX_TESTED_VERSION)!) <= 0;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): Semver | undefined {
  const parts = v.trim().split(".");
  if (parts.length !== 3) return undefined;
  const [major, minor, patch] = parts.map(Number);
  if ([major, minor, patch].some((n) => !Number.isInteger(n) || n < 0)) {
    return undefined;
  }
  return { major, minor, patch };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
