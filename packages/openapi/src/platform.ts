/**
 * Portable source acquisition for browser, Worker, and server runtimes.
 *
 * This package deliberately owns no filesystem implementation. Applications
 * that choose a Node filesystem read the artifact themselves and pass
 * `content`, or inject a fetch implementation for file: invocation.
 */

/** Absolute artifact URIs pass through; process-local paths are not portable. */
export function normalizeAuthoringLocation(
  location?: string,
): string | undefined {
  if (!location) return location;
  try {
    new URL(location);
    return location;
  } catch {
    throw new Error(
      `cannot use process-local authoring path ${JSON.stringify(location)}: pass embedded content or an absolute artifact URI`,
    );
  }
}

/** Reads one artifact for an explicit embed request using web-platform fetch. */
export async function readAuthoringArtifact(
  location: string,
  signal?: AbortSignal,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const url = new URL(location);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `cannot embed ${location}: the portable synthesizer fetches HTTP(S); read the artifact in the host runtime and pass it as content`,
    );
  }
  const response = await fetchFn(url, { signal });
  if (!response.ok) {
    throw new Error(
      `failed to fetch ${location}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}
