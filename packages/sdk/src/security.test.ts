import { describe, it, expect } from "vitest";
import { resolveSecurity } from "./security.js";
import type { SecurityMethod } from "./types.js";
import type { PlatformCallbacks } from "./context.js";

// Helper: create callbacks with a prompt that returns predefined values by label
function mockCallbacks(responses: Record<string, string>): PlatformCallbacks {
    return {
        prompt: async (msg: string, opts?: { label?: string; secret?: boolean }) => {
            const label = opts?.label ?? "";
            if (label in responses) return responses[label];
            throw new Error(`unexpected prompt for label "${label}"`);
        },
    };
}

describe("resolveSecurity", () => {
    it("resolves bearer method via prompt", async () => {
        const methods: SecurityMethod[] = [{ type: "bearer" }];
        const result = await resolveSecurity(methods, mockCallbacks({ bearerToken: "tok_123" }));
        expect(result).toEqual({ bearerToken: "tok_123" });
    });

    it("resolves apiKey method via prompt", async () => {
        const methods: SecurityMethod[] = [{ type: "apiKey" }];
        const result = await resolveSecurity(methods, mockCallbacks({ apiKey: "key_abc" }));
        expect(result).toEqual({ apiKey: "key_abc" });
    });

    it("resolves basic method via two prompts", async () => {
        const methods: SecurityMethod[] = [{ type: "basic" }];
        const result = await resolveSecurity(methods, mockCallbacks({ username: "user", password: "pass" }));
        expect(result).toEqual({ basic: { username: "user", password: "pass" } });
    });

    it("resolves oauth2 via bearer prompt fallback", async () => {
        const methods: SecurityMethod[] = [{ type: "oauth2" }];
        const result = await resolveSecurity(methods, mockCallbacks({ bearerToken: "oauth_tok" }));
        expect(result).toEqual({ bearerToken: "oauth_tok" });
    });

    it("skips unknown type and tries next", async () => {
        const methods: SecurityMethod[] = [
            { type: "custom_unknown" },
            { type: "bearer" },
        ];
        const result = await resolveSecurity(methods, mockCallbacks({ bearerToken: "tok" }));
        expect(result).toEqual({ bearerToken: "tok" });
    });

    it("returns null for empty methods", async () => {
        const result = await resolveSecurity([], mockCallbacks({ bearerToken: "tok" }));
        expect(result).toBeNull();
    });

    it("returns null when no callbacks", async () => {
        const methods: SecurityMethod[] = [{ type: "bearer" }];
        const result = await resolveSecurity(methods, {} as PlatformCallbacks);
        expect(result).toBeNull();
    });

    it("returns null when prompt returns empty string", async () => {
        const methods: SecurityMethod[] = [{ type: "bearer" }];
        const result = await resolveSecurity(methods, mockCallbacks({ bearerToken: "" }));
        expect(result).toBeNull();
    });

    it("respects preference order (first successful wins)", async () => {
        const methods: SecurityMethod[] = [
            { type: "bearer" },
            { type: "apiKey" },
        ];
        const result = await resolveSecurity(methods, mockCallbacks({ bearerToken: "first", apiKey: "second" }));
        expect(result).toEqual({ bearerToken: "first" });
    });

    it("resolves oauth2 via PKCE when BrowserRedirect is available", async () => {
        // Mock token server - in test we just verify the flow works
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            // Verify it's a token exchange request
            const body = init?.body?.toString() ?? "";
            if (body.includes("grant_type=authorization_code") && body.includes("code_verifier=")) {
                return new Response(JSON.stringify({ access_token: "pkce_token_123", token_type: "Bearer" }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }
            return new Response("not found", { status: 404 });
        };

        try {
            const methods: SecurityMethod[] = [{
                type: "oauth2",
                authorizeUrl: "https://auth.example.com/authorize",
                tokenUrl: "https://auth.example.com/token",
                scopes: ["read"],
            }];

            const callbacks: PlatformCallbacks = {
                browserRedirect: async (url: string) => {
                    const parsed = new URL(url);
                    const state = parsed.searchParams.get("state");
                    return {
                        callbackURL: `http://localhost:0/callback?code=auth_code&state=${state}`,
                        redirectUri: "http://localhost:0/callback",
                    };
                },
            };

            const result = await resolveSecurity(methods, callbacks);
            expect(result).toEqual({ bearerToken: "pkce_token_123" });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("uses description in prompt message", async () => {
        let promptMessage = "";
        const callbacks: PlatformCallbacks = {
            prompt: async (msg: string, opts?: { label?: string; secret?: boolean }) => {
                promptMessage = msg;
                return "tok";
            },
        };
        await resolveSecurity([{ type: "bearer", description: "Paste your API key" }], callbacks);
        expect(promptMessage).toBe("Paste your API key");
    });
});
