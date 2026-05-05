// Supported OpenBindings versions for this SDK.
export const MIN_SUPPORTED_VERSION = "0.2.0";
export const MAX_TESTED_VERSION = "0.2.0";

export function supportedRange(): { min: string; max: string } {
  return { min: MIN_SUPPORTED_VERSION, max: MAX_TESTED_VERSION };
}

export function isSupportedVersion(v: string): boolean {
  const parsed = parseSemverStrict(v);
  if (!parsed) return false;
  return (
    compareSemver(parsed, parseSemverStrict(MIN_SUPPORTED_VERSION)!) >= 0 &&
    compareSemver(parsed, parseSemverStrict(MAX_TESTED_VERSION)!) <= 0
  );
}

/**
 * Reports whether v is "higher" than the SDK's MAX_TESTED_VERSION in the sense
 * OBI-T-04 mandates refusal:
 *   - Strictly higher major version, OR
 *   - While the SDK's MAX_TESTED_VERSION is pre-1.0 (major == 0), strictly
 *     higher minor version.
 *
 * Throws if v cannot be parsed as a SemVer 2.0.0 string.
 */
export function isHigherMajorOrPre1MinorThanMaxTested(v: string): boolean {
  const parsed = parseSemverStrict(v);
  if (!parsed) {
    throw new Error(`invalid semver: ${JSON.stringify(v)}`);
  }
  const max = parseSemverStrict(MAX_TESTED_VERSION)!;
  if (parsed.major > max.major) return true;
  if (max.major === 0 && parsed.major === 0 && parsed.minor > max.minor) {
    return true;
  }
  return false;
}

/**
 * Parsed SemVer 2.0.0 value. Build metadata is ignored for precedence
 * comparison per SemVer 2.0.0 §10.
 */
interface Semver {
  major: number;
  minor: number;
  patch: number;
  preRelease: string[]; // empty if no pre-release
  build: string; // raw build metadata; informational only
}

// Official SemVer 2.0.0 regex from semver.org.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(v: string): boolean {
  return SEMVER_PATTERN.test(v.trim());
}

function parseSemverStrict(v: string): Semver | undefined {
  const m = SEMVER_PATTERN.exec(v.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    preRelease: m[4] ? m[4].split(".") : [],
    build: m[5] ?? "",
  };
}

/**
 * Compares two SemVer 2.0.0 values per §11. Build metadata is ignored.
 *
 * Returns:
 *   - negative if a < b
 *   - 0 if a == b (equal precedence)
 *   - positive if a > b
 */
function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Equal numeric: a version with pre-release has lower precedence than the
  // same normal version without pre-release.
  if (a.preRelease.length === 0 && b.preRelease.length === 0) return 0;
  if (a.preRelease.length === 0) return 1;
  if (b.preRelease.length === 0) return -1;
  // Both have pre-release: compare identifiers left-to-right.
  const len = Math.min(a.preRelease.length, b.preRelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.preRelease[i];
    const bi = b.preRelease[i];
    const aNum = isNumericIdent(ai);
    const bNum = isNumericIdent(bi);
    if (aNum && bNum) {
      const an = Number(ai);
      const bn = Number(bi);
      if (an !== bn) return an - bn;
    } else if (aNum) {
      return -1; // numeric identifiers always have lower precedence
    } else if (bNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return a.preRelease.length - b.preRelease.length;
}

function isNumericIdent(id: string): boolean {
  if (id.length === 0) return false;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}
