const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]*@[A-Za-z0-9][A-Za-z0-9.\-]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]*$/;

export interface FormatToken {
  name: string;
  version: string;
}

export function formatTokenToString(t: FormatToken): string {
  if (!t.name || !t.version) return "";
  return `${t.name}@${t.version}`;
}

export function parseFormatToken(s: string): FormatToken {
  const trimmed = s.trim();
  if (!trimmed) throw new Error("format token: empty");
  if (!TOKEN_RE.test(trimmed)) throw new Error(`format token: invalid "${trimmed}"`);
  const at = trimmed.lastIndexOf("@");
  return {
    name: trimmed.slice(0, at).toLowerCase(),
    version: trimmed.slice(at + 1),
  };
}

export function isFormatToken(s: string): boolean {
  try {
    parseFormatToken(s);
    return true;
  } catch {
    return false;
  }
}

export function normalizeFormatToken(s: string): string {
  return formatTokenToString(parseFormatToken(s));
}

export function isValidFormatName(s: string): boolean {
  const trimmed = s.trim();
  return trimmed !== "" && !trimmed.includes("@") && NAME_RE.test(trimmed);
}

export function isOpenBindingsToken(t: FormatToken): boolean {
  return t.name === "openbindings";
}

// ---------------------------------------------------------------------------
// Semver range matching
// ---------------------------------------------------------------------------

export type RangeKind = "versionless" | "exact" | "caret";

export interface VersionRange {
  name: string;
  kind: RangeKind;
  version: string;
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a range token used by executors.
 *
 *  "grpc"            → versionless
 *  "openapi@^3.0.0"  → caret
 *  "openapi@^3.0"    → caret
 *  "mcp@2025-11-25"  → exact
 *  "openapi@3.1"     → exact
 */
export function parseRange(s: string): VersionRange {
  const trimmed = s.trim();
  if (!trimmed) throw new Error("parseRange: empty input");

  const at = trimmed.indexOf("@");
  if (at < 0) {
    return { name: trimmed.toLowerCase(), kind: "versionless", version: "", major: 0, minor: 0, patch: 0 };
  }

  const name = trimmed.slice(0, at).toLowerCase();
  const ver = trimmed.slice(at + 1);

  if (ver.startsWith("^")) {
    const raw = ver.slice(1);
    const parts = raw.split(".");
    const major = parseInt(parts[0] ?? "0", 10);
    const minor = parseInt(parts[1] ?? "0", 10);
    const patch = parseInt(parts[2] ?? "0", 10);
    return { name, kind: "caret", version: raw, major, minor, patch };
  }

  return { name, kind: "exact", version: ver, major: 0, minor: 0, patch: 0 };
}

/**
 * Normalize a numeric version by stripping trailing ".0" segments.
 * "3.1.0" → "3.1", "3.0.0" → "3", but "2025-11-25" stays unchanged.
 */
function normalizeVersion(v: string): string {
  // Only normalize dot-separated purely-numeric versions
  const parts = v.split(".");
  if (!parts.every((p) => /^\d+$/.test(p))) return v;
  while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
  return parts.join(".");
}

function parseNumericVersion(v: string): { major: number; minor: number; patch: number } | null {
  const parts = v.split(".");
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  return {
    major: parseInt(parts[0] ?? "0", 10),
    minor: parseInt(parts[1] ?? "0", 10),
    patch: parseInt(parts[2] ?? "0", 10),
  };
}

/**
 * Check whether an exact source token satisfies a version range.
 */
export function matchesRange(vr: VersionRange, sourceToken: string): boolean {
  const trimmed = sourceToken.trim();
  const at = trimmed.indexOf("@");
  const srcName = at < 0 ? trimmed.toLowerCase() : trimmed.slice(0, at).toLowerCase();
  const srcVersion = at < 0 ? undefined : trimmed.slice(at + 1);

  if (srcName !== vr.name) return false;


  switch (vr.kind) {
    case "versionless":
      return srcVersion === undefined;

    case "exact":
      if (srcVersion === undefined) return false;
      return normalizeVersion(vr.version) === normalizeVersion(srcVersion);

    case "caret": {
      if (srcVersion === undefined) return false;
      const src = parseNumericVersion(srcVersion);
      if (!src) return false;
      if (src.major !== vr.major) return false;
      if (src.minor > vr.minor) return true;
      if (src.minor === vr.minor && src.patch >= vr.patch) return true;
      return false;
    }
  }
}
