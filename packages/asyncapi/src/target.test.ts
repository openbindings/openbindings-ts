import { describe, expect, it } from "vitest";
import type { AsyncAPIChannel, AsyncAPIDocument, AsyncAPIServer } from "./asyncapi-types.js";
import { SERVER_NAME_TAG } from "./constants.js";
import { resolveTarget } from "./target.js";

// Unit coverage for resolveTarget's sole-member selection and the legacy
// metadata.baseURL override (ASYNC-P-04, §9.5). Mirrors the Go SDK's
// TestResolveTarget_* in util_test.go; the full configuration-point matrix
// is exercised end to end in conformance.test.ts.

function doc(): AsyncAPIDocument {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    servers: {
      prod: { host: "api.example.com", protocol: "https" },
    },
  };
}

describe("resolveTarget", () => {
  it("assembles the default server and carries it as the security server", () => {
    const d = doc();
    const target = resolveTarget(d, undefined, undefined);
    expect(target.protocol).toBe("https");
    expect(target.serverURL).toBe("https://api.example.com");
    expect(target.securityServer).toBe(d.servers!.prod);
  });

  it("honors a same-scheme metadata.baseURL replacement, keeping the selected server's security", () => {
    const d = doc();
    const target = resolveTarget(d, undefined, {
      metadata: { baseURL: "https://localhost:8080" },
    });
    expect(target.protocol).toBe("https");
    expect(target.serverURL).toBe("https://localhost:8080");
    expect(target.securityServer).toBe(d.servers!.prod);
  });

  it("refuses when the document declares no servers", () => {
    const empty: AsyncAPIDocument = { asyncapi: "3.0.0", info: { title: "t", version: "1" } };
    expect(() => resolveTarget(empty, undefined, undefined)).toThrow(/declares no server/);
  });

  it("a channel-servers entry naming no OWN servers-map key contributes nothing, leaving the structured no-resolvable-server refusal", () => {
    // A malformed artifact may carry an inline (non-$ref) channel `servers`
    // entry with a forged name tag. A name like "constructor" matches
    // Object.prototype under an `in` test, so the effective-set membership
    // check must be an own-key lookup: the entry contributes nothing (the
    // structured refusal below), never surfaces a prototype member as a
    // "server" (which would otherwise TypeError during server selection). Go-map parity:
    // a Go map lookup never sees anything but its own keys.
    const d = doc();
    const forged = { [SERVER_NAME_TAG]: "constructor" } as unknown as AsyncAPIServer;
    const ch: AsyncAPIChannel = { address: "/x", servers: [forged] };
    expect(() => resolveTarget(d, ch, undefined)).toThrow(/declares no server/);
  });
});

// This SDK's composable carriage for §9.2's server point. Mirrors the Go
// SDK's target tests; the shape is deliberately similar across languages
// while remaining implementation surface.
describe("resolveTarget §9.2 server configuration carriage", () => {
  function twoServerDoc(): AsyncAPIDocument {
    return {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        backup: { host: "backup.example.com", protocol: "wss" },
        prod: { host: "api.example.com", protocol: "https" },
      },
    };
  }
  const cfg = (server: unknown) => ({ configuration: { server } });

  it('accepts {"key": ...}: member selection by servers-map key', () => {
    const d = twoServerDoc();
    const target = resolveTarget(d, undefined, cfg({ key: "backup" }));
    expect(target.serverURL).toBe("wss://backup.example.com");
    expect(target.protocol).toBe("wss");
    expect(target.securityServer).toBe(d.servers!.backup);
  });

  it('accepts {"key", "url"}: selected-member same-scheme URL replacement', () => {
    const d = twoServerDoc();
    const target = resolveTarget(d, undefined, cfg({ key: "backup", url: "wss://localhost:9090/base" }));
    expect(target.serverURL).toBe("wss://localhost:9090/base");
    expect(target.protocol).toBe("wss");
    expect(target.securityServer).toBe(d.servers!.backup);
  });

  const tail =
    'this implementation accepts {"key": "<server-name>"?, "variables": {"<variable-name>": "<string-value>"}?, "url": "<connection-url>"?}; "key" selects an artifact member (required when several bindable members remain), "variables" completes that member, "url" may replace only that selected member\'s target with the same scheme, and when the artifact declares no server "url" alone supplies the whole connection URL';

  const refusals: Array<{ name: string; value: unknown; want: string }> = [
    {
      name: "bare string (retired member-name form)",
      value: "prod",
      want: "configuration.server must be an object: " + tail,
    },
    {
      name: "bare string (retired URL form)",
      value: "wss://api.example.com/v2",
      want: "configuration.server must be an object: " + tail,
    },
    {
      name: "array",
      value: ["prod"],
      want: "configuration.server must be an object: " + tail,
    },
    {
      name: "retired name member",
      value: { name: "prod" },
      want: 'configuration.server member "name" is not pinned: ' + tail,
    },
    {
      name: "two unpinned members",
      value: { mode: "fast", name: "prod" },
      want: 'configuration.server members "mode", "name" are not pinned: ' + tail,
    },
    {
      name: "empty object",
      value: {},
      want: 'configuration.server carries none of "key", "variables", or "url": ' + tail,
    },
    {
      name: "key not a string",
      value: { key: 3 },
      want: "configuration.server.key must be a non-empty string: " + tail,
    },
    {
      name: "key empty",
      value: { key: "" },
      want: "configuration.server.key must be a non-empty string: " + tail,
    },
    {
      name: "url not a string",
      value: { url: 3 },
      want: "configuration.server.url must be a non-empty string: " + tail,
    },
    {
      name: "url empty",
      value: { url: "" },
      want: "configuration.server.url must be a non-empty string: " + tail,
    },
    {
      name: "variables not an object",
      value: { key: "prod", variables: "staging" },
      want: "configuration.server.variables must be an object of string values: " + tail,
    },
    {
      name: "variables null",
      value: { key: "prod", variables: null },
      want: "configuration.server.variables must be an object of string values: " + tail,
    },
    {
      name: "variables entry not a string",
      value: { key: "prod", variables: { env: 3 } },
      want: 'configuration.server.variables["env"] must be a string value: ' + tail,
    },
    {
      name: "key names no member",
      value: { key: "nope" },
      want: 'configuration.server.key "nope" names no member of the effective server set',
    },
    {
      name: "variables name not declared",
      value: { key: "prod", variables: { env: "staging" } },
      want: 'configuration.server.variables["env"] names no declared variable of server "prod"',
    },
  ];

  for (const tc of refusals) {
    it(`refuses ${tc.name} with the teaching error`, () => {
      let message = "";
      try {
        resolveTarget(twoServerDoc(), undefined, cfg(tc.value));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(tc.want);
    });
  }

  it("requires key selection before a valid URL replacement when several members remain", () => {
    expect(() => resolveTarget(twoServerDoc(), undefined, cfg({ url: "wss://override.example" })))
      .toThrow(/configuration\.server\.key must select/);
  });

  it("requires key selection before variables can complete one of several members", () => {
    expect(() => resolveTarget(twoServerDoc(), undefined, cfg({ variables: { env: "staging" } })))
      .toThrow(/configuration\.server\.key must select/);
  });
});

// §9.2's `variables` member of the server pin's key form (ratified
// 2026-07-21): supplied values for the selected server's own declared
// variables, substitution supplied-else-default-else-refusal, a supplied
// value outside the declared enum refused (upstream SHOULD, hardened to a
// refusal — the specification's own pin), an undeclared supplied name
// refused, never ignored. AsyncAPI declares a Server Variable's default
// OPTIONAL, so an undefaulted variable is satisfiable only by consumer
// supply. Mirrors the Go SDK's TestResolveTarget_ServerVariablesCarriage.
describe("resolveTarget §9.2 server variables carriage", () => {
  function variableDoc(): AsyncAPIDocument {
    return {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        tiered: {
          host: "{env}.example.com",
          protocol: "wss",
          pathname: "/{version}",
          variables: {
            env: { default: "prod", enum: ["prod", "staging"] },
            version: { default: "v1" },
          },
        },
        bare: {
          host: "{tenant}.example.com",
          protocol: "ws",
          variables: {
            tenant: {}, // no default: satisfiable only by supply
          },
        },
      },
    };
  }
  const cfg = (server: unknown) => ({ configuration: { server } });

  it("substitutes a supplied value over the declared default", () => {
    const target = resolveTarget(variableDoc(), undefined, cfg({
      key: "tiered",
      variables: { env: "staging" },
    }));
    expect(target.serverURL).toBe("wss://staging.example.com/v1");
  });

  it("falls to the declared default for unsupplied variables; an empty variables object is the same as none", () => {
    const target = resolveTarget(variableDoc(), undefined, cfg({ key: "tiered", variables: {} }));
    expect(target.serverURL).toBe("wss://prod.example.com/v1");
  });

  it("satisfies an undefaulted variable by supply — the carriage the assembly rule presupposes", () => {
    const target = resolveTarget(variableDoc(), undefined, cfg({
      key: "bare",
      variables: { tenant: "acme" },
    }));
    expect(target.serverURL).toBe("ws://acme.example.com");
  });

  it("refuses an undefaulted, unsupplied variable with the supply remedy", () => {
    let message = "";
    try {
      resolveTarget(variableDoc(), undefined, cfg({ key: "bare" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      'server "bare": variable "tenant" has no supplied value and no declared default (supply one at the server configuration point\'s "variables" member)',
    );
  });

  it("refuses a supplied value outside the artifact-declared enum", () => {
    expect(() => resolveTarget(
      variableDoc(),
      undefined,
      cfg({ key: "tiered", variables: { env: "qa" } }),
    )).toThrow(/artifact-declared enum/);
  });

  it("refuses a supplied name the selected server does not declare, even when every expression would resolve", () => {
    let message = "";
    try {
      resolveTarget(variableDoc(), undefined, cfg({ key: "tiered", variables: { region: "eu" } }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      'configuration.server.variables["region"] names no declared variable of server "tiered"',
    );
  });
});

// An artifact declaring no server is a complete target whose reachability is
// consumer configuration (ruled 2026-08-13, R1+R5); Go twin:
// TestResolveTarget_NoServers.
describe("resolveTarget with no artifact servers", () => {
  const doc = { asyncapi: "3.0.0", info: { title: "t", version: "1" } } as unknown as AsyncAPIDocument;
  const cfg = (server: unknown) => ({ configuration: { server } });

  it("challenges config.value at point server, path /url when unconfigured", () => {
    try {
      resolveTarget(doc, undefined, {});
      expect.unreachable("expected a config-required challenge");
    } catch (error: unknown) {
      const challenge = error as { name?: string; point?: string; path?: string };
      expect(challenge.name).toBe("ConfigRequired");
      expect(challenge.point).toBe("server");
      expect(challenge.path).toBe("/url");
    }
  });

  it("accepts url alone as the whole connection URL, scheme carrying protocol", () => {
    const target = resolveTarget(doc, undefined, cfg({ url: "wss://broker.example.com/v1" }));
    expect(target.serverURL).toBe("wss://broker.example.com/v1");
    expect(target.protocol).toBe("wss");
  });

  it("refuses variables when the artifact declares no server", () => {
    expect(() => resolveTarget(doc, undefined, cfg({ url: "wss://broker.example.com", variables: { x: "y" } })))
      .toThrowError(/variables completes an artifact-declared server/);
  });

  it("refuses an unbound scheme pre-dispatch", () => {
    expect(() => resolveTarget(doc, undefined, cfg({ url: "kafka://broker.example.com:9092" })))
      .toThrowError(/not bound by the supported openbindings.asyncapi revisions/);
  });
});
