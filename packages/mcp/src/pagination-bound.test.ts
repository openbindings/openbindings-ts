import { describe, it, expect } from "vitest";
import { exhaustPages } from "./listing.js";

// C7f: MCP-P-02 mandates pagination exhaustion, not unbounded trust. A server
// that repeats a cursor (or never stops returning one) is refused with
// ERR_PROTOCOL — the same observable refusal the Go SDK's item bound produces.
describe("exhaustPages pagination bound (C7f)", () => {
  it("refuses a server that repeats its nextCursor (ERR_PROTOCOL)", async () => {
    let calls = 0;
    await expect(
      exhaustPages(
        async () => {
          calls++;
          return { nextCursor: "same" };
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "ERR_PROTOCOL" });
    // Caught on the repeat, not looping forever.
    expect(calls).toBeLessThan(5);
  });

  it("exhausts a terminating server normally", async () => {
    const pages: Array<{ nextCursor?: string }> = [{ nextCursor: "p2" }, { nextCursor: "p3" }, {}];
    let i = 0;
    let collected = 0;
    await exhaustPages(
      async () => pages[i++],
      () => {
        collected++;
      },
    );
    expect(collected).toBe(3);
  });
});
