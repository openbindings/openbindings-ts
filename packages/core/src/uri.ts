/**
 * URI normalization and reference resolution (spec §10, Reference
 * resolution).
 *
 * resolveRef converts a relative URI reference (in sources[*].location or a
 * schema $ref) into a fully-qualified URI, per spec §10.
 * canonicalizeLocation produces a normalized form useful for caching and
 * deduplicating fetched documents; comparing URIs for identity is a tool
 * concern (the spec defines no canonical URI equality), and this SDK's
 * normalization is its own convention.
 *
 * The canonicalization algorithm uses the WHATWG URL Standard for the
 * heavy lifting (lowercase scheme/host, IDN punycode via UTS #46,
 * default-port stripping, dot-segment removal). On top of that we lift
 * bare absolute filesystem paths to file:// URIs (RFC 8089), apply
 * RFC 3986 §6.2.2 percent-encoding normalization (decode unreserved,
 * uppercase reserved hex), and strip the fragment.
 */

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Produces a normalized form of a URI suitable for caching and
 * deduplicating fetched documents. The spec (v0.2.0 §10) defines no
 * canonical URI equality — identity comparison is a tool concern — so this
 * is an SDK convention applying RFC 3986 §6.2 syntax-based normalization:
 * trivially equivalent spellings of the same location compare equal, while
 * distinct normalized forms may still address the same resource.
 *
 * Steps applied in order:
 *
 * 1. Bare absolute filesystem paths are lifted to `file://` URIs (RFC 8089).
 * 2. Percent-encoded unreserved characters are decoded; remaining percent
 *    escapes have their hex digits uppercased (RFC 3986 §6.2.2).
 * 3. Scheme and host are lowercased; host labels are converted to A-label
 *    form (UTS #46) by the WHATWG URL parser; default ports are stripped;
 *    dot-segments are removed; an empty path becomes `/` when the URI has
 *    an authority.
 * 4. The fragment component is stripped.
 *
 * Path and query case, query strings, userinfo, scheme (http vs https),
 * and trailing slashes on non-empty paths remain significant.
 */
export function canonicalizeLocation(uri: string): string {
  if (!uri) {
    throw new Error("openbindings: cannot canonicalize empty URI");
  }
  if (uri.startsWith("/")) {
    uri = "file://" + uri;
  }

  // Apply percent-encoding normalization on the raw input first. The
  // WHATWG URL parser handles its own encode/decode internally; doing this
  // pass first keeps reserved %XX (e.g., %2F representing a literal slash)
  // in canonical hex case before parsing.
  uri = normalizePercentEncoding(uri);

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (e) {
    throw new Error(
      `openbindings: parse URI ${JSON.stringify(uri)}: ${(e as Error).message}`,
      { cause: e },
    );
  }

  parsed.hash = "";
  return parsed.toString();
}

/**
 * Resolves a relative URI reference against a base URI per RFC 3986 §5.
 * This is the spec §10 (Reference resolution) operation: it converts a
 * sources[*].location or a schema $ref into a fully-qualified URI suitable
 * for fetching or comparison.
 *
 * Resolution is directory-relative: the merge step strips everything after
 * the last `/` in the base URI's path before appending the reference
 * (RFC 3986 §5.2.3). The WHATWG URL constructor implements this when given
 * a base URI.
 *
 * An absolute reference is returned unchanged. A relative reference
 * requires a non-empty absolute base; otherwise resolveRef throws.
 * JSON Pointer fragments (RFC 6901) are preserved by the URL constructor
 * without further handling.
 */
export function resolveRef(base: string, ref: string): string {
  if (!ref) {
    throw new Error("openbindings: cannot resolve empty reference");
  }

  // If `ref` parses as a standalone URL, it's absolute. Per spec §10,
  // absolute references are returned unchanged (base not consulted).
  try {
    new URL(ref);
    return ref;
  } catch {
    // Relative; needs base.
  }

  if (!base) {
    throw new Error(
      `openbindings: cannot resolve relative reference ${JSON.stringify(ref)} without a base URI`,
    );
  }
  let baseURL: URL;
  try {
    baseURL = new URL(base);
  } catch (e) {
    throw new Error(
      `openbindings: parse base ${JSON.stringify(base)}: ${(e as Error).message}`,
      { cause: e },
    );
  }
  if (!baseURL.protocol) {
    throw new Error(`openbindings: base ${JSON.stringify(base)} is not absolute`);
  }
  let resolved: URL;
  try {
    resolved = new URL(ref, baseURL);
  } catch (e) {
    throw new Error(
      `openbindings: resolve ${JSON.stringify(ref)} against ${JSON.stringify(base)}: ${(e as Error).message}`,
      { cause: e },
    );
  }
  return resolved.toString();
}

/**
 * Decodes percent-encoded unreserved characters per RFC 3986 §2.3
 * (ALPHA / DIGIT / "-" / "." / "_" / "~") and uppercases the hex digits in
 * any remaining percent escapes. Part of RFC 3986 §6.2.2 syntax-based
 * normalization.
 */
function normalizePercentEncoding(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c !== "%" || i + 2 >= s.length) {
      out += c;
      continue;
    }
    const h1 = s.charAt(i + 1);
    const h2 = s.charAt(i + 2);
    const hi = hexNibble(h1);
    const lo = hexNibble(h2);
    if (hi < 0 || lo < 0) {
      out += c;
      continue;
    }
    const code = (hi << 4) | lo;
    const ch = String.fromCharCode(code);
    if (UNRESERVED.test(ch)) {
      out += ch;
    } else {
      out += "%" + h1.toUpperCase() + h2.toUpperCase();
    }
    i += 2;
  }
  return out;
}

function hexNibble(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 97 + 10; // a-f
  if (code >= 65 && code <= 70) return code - 65 + 10; // A-F
  return -1;
}

/**
 * Returns the keys of `obj` that are not in the `known` set. Useful for
 * surfacing extension fields (typically `x-` prefixed) on a typed
 * OpenBindings object at runtime, where TypeScript's nominal typing
 * hides them from the type system but JavaScript naturally preserves them.
 *
 * Note: parseDocument and JSON.parse preserve unknown fields naturally
 * (TS object literals are open at runtime). Modifications via
 * `{ ...iface, name: "new" }` or `Object.assign({}, iface, patch)` also
 * preserve unknown fields. Loss only occurs if calling code explicitly
 * reconstructs an Interface from typed fields only.
 */
export function unknownFields(
  obj: Record<string, unknown>,
  known: ReadonlySet<string> | readonly string[],
): Record<string, unknown> {
  const knownSet = known instanceof Set ? known : new Set(known);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (!knownSet.has(k)) {
      out[k] = obj[k];
    }
  }
  return out;
}
