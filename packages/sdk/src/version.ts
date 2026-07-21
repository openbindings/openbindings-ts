// Supported OpenBindings versions for this SDK.
export const MIN_SUPPORTED_VERSION = "0.2.0";
export const MAX_TESTED_VERSION = "0.2.0";

export function supportedRange(): { min: string; max: string } {
  return { min: MIN_SUPPORTED_VERSION, max: MAX_TESTED_VERSION };
}

/**
 * Reports whether this SDK will ACCEPT (process rather than refuse) a document
 * declaring OpenBindings version `v` — the OBI-T-04 acceptance question, not a
 * tested-range membership test. Returns true iff `validateInterface` /
 * `parseDocument` would NOT emit a version refusal for `v`: a different major is
 * refused; while pre-1.0 a different minor is refused; a higher or lower PATCH
 * is never a refusal; a prerelease is accepted only when explicitly supported.
 * So a 0.2.0 SDK accepts 0.2.1, 0.2.99, etc. and refuses 0.1.x / 0.3.x.
 *
 * This is distinct from — and wider than — the maintainer-tested range reported
 * by {@link MIN_SUPPORTED_VERSION} / {@link MAX_TESTED_VERSION} /
 * {@link supportedRange}: a version can be accepted without being inside the
 * tested range. It shares the single refusal predicate
 * ({@link versionRefusalReason}) the validation paths use, so the oracle cannot
 * drift from the actual accept/refuse decision. A malformed (non-SemVer) `v` is
 * refused (returns false).
 */
export function isSupportedVersion(v: string): boolean {
  if (!isValidSemver(v)) return false;
  return versionRefusalReason(v) === undefined;
}

/**
 * The single OBI-T-04 accept/refuse evaluation shared by `validateInterface`,
 * `parseDocument`, and {@link isSupportedVersion}, so the diagnostic path and
 * the acceptance oracle consult the same ordered predicate chain and cannot
 * diverge. Returns the diagnostic core — to which callers add the
 * `openbindings:` prefix and `(OBI-T-04)` suffix — when this SDK MUST refuse to
 * process a document declaring SemVer version `v`, or `undefined` when the SDK
 * accepts it. `v` MUST be well-formed SemVer (callers gate on
 * {@link isValidSemver} / the schema pattern first); throws otherwise.
 */
export function versionRefusalReason(v: string): string | undefined {
  if (isHigherMajorOrPre1MinorThanMaxTested(v)) {
    return `document declares version "${v}", newer than the latest version this implementation supports (${MAX_TESTED_VERSION})`;
  }
  if (isLowerThanMinSupported(v)) {
    return `document declares version "${v}", older than the oldest version this implementation supports (${MIN_SUPPORTED_VERSION})`;
  }
  if (isUnsupportedPrerelease(v)) {
    return `document declares version "${v}", a pre-release this implementation does not support`;
  }
  return undefined;
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
 * Reports whether v carries a pre-release identifier this SDK does not declare
 * support for. Per OBI-T-04 and §11.1, a tool MUST NOT accept a prerelease
 * unless it declares support for that specific prerelease; "declares support"
 * means the prerelease falls within this SDK's supported range
 * [MIN_SUPPORTED_VERSION, MAX_TESTED_VERSION]. A prerelease sorts below its
 * release, so against a non-prerelease MAX_TESTED_VERSION no prerelease is in
 * range. Non-prerelease versions and build metadata are never flagged.
 */
/**
 * Reports whether v falls below the SDK's MIN_SUPPORTED_VERSION in the sense
 * OBI-T-04 mandates refusal — the downward half of the rule: a version
 * outside the supported range in either direction is refused rather than
 * processed under the wrong rules (pre-1.0 minors may change field semantics
 * both ways). Mirrors the upward rule's granularity: lower major always
 * refuses; a lower minor refuses only while the floor is pre-1.0 (post-1.0
 * minors are additive, so an older minor within a supported major reads
 * safely). Patch is never a refusal trigger.
 */
export function isLowerThanMinSupported(v: string): boolean {
  const parsed = parseSemverStrict(v);
  if (!parsed) {
    throw new Error(`invalid semver: ${JSON.stringify(v)}`);
  }
  const min = parseSemverStrict(MIN_SUPPORTED_VERSION)!;
  if (parsed.major < min.major) return true;
  if (min.major === 0 && parsed.major === 0 && parsed.minor < min.minor) {
    return true;
  }
  return false;
}

export function isUnsupportedPrerelease(v: string): boolean {
  const parsed = parseSemverStrict(v);
  if (!parsed || parsed.preRelease.length === 0) return false;
  const inRange =
    compareSemver(parsed, parseSemverStrict(MIN_SUPPORTED_VERSION)!) >= 0 &&
    compareSemver(parsed, parseSemverStrict(MAX_TESTED_VERSION)!) <= 0;
  return !inRange;
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
    const ai = a.preRelease.at(i);
    const bi = b.preRelease.at(i);
    // i < min(a.preRelease.length, b.preRelease.length): both reads are in
    // bounds; the guard exists for the type system.
    if (ai === undefined || bi === undefined) break;
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
