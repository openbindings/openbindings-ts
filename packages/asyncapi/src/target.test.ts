import { describe, expect, it } from "vitest";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { resolveTarget } from "./target.js";

// Unit coverage for resolveTarget's default selection and the legacy
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

  it("honors the legacy metadata.baseURL override below the configuration point, keeping the default-selected server's security", () => {
    const d = doc();
    const target = resolveTarget(d, undefined, {
      metadata: { baseURL: "http://localhost:8080" },
    });
    expect(target.protocol).toBe("http");
    expect(target.serverURL).toBe("http://localhost:8080");
    // Under a full-URL override the declared security of the server the
    // default selection would have targeted still applies (§9.5).
    expect(target.securityServer).toBe(d.servers!.prod);
  });

  it("refuses when the document declares no servers", () => {
    const empty: AsyncAPIDocument = { asyncapi: "3.0.0", info: { title: "t", version: "1" } };
    expect(() => resolveTarget(empty, undefined, undefined)).toThrow(/no resolvable server/);
  });
});

// §9.2's configuration value shapes for the server point: {"key":
// "<server-name>", "variables": {"<variable-name>": "<string-value>"}?}
// selects a member of the effective server set, optionally supplying its
// declared server variables, xor {"url": "<connection-url>"} overrides
// with a complete URL. Mirrors the Go SDK's TestResolveTarget_PinnedShapes
// / TestResolveTarget_ServerVariablesCarriage /
// TestResolveTarget_ShapeTeachingErrors in util_test.go — the refusal
// strings below are byte-identical by construction (the pin exists "so two
// implementations carry it identically").
describe("resolveTarget §9.2 pinned value shapes", () => {
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

  it('accepts {"url": ...}: complete connection URL, scheme decides, default-selected security applies', () => {
    const d = twoServerDoc();
    const target = resolveTarget(d, undefined, cfg({ url: "ws://localhost:9090/base" }));
    expect(target.serverURL).toBe("ws://localhost:9090/base");
    expect(target.protocol).toBe("ws");
    expect(target.securityServer).toBe(d.servers!.backup);
  });

  const tail =
    'the pinned shapes (openbindings.asyncapi@1 §9.2) are {"key": "<server-name>", "variables": {"<variable-name>": "<string-value>"}?} (select a member of the effective server set, "variables" optionally supplying its declared server variables) xor {"url": "<connection-url>"} (override with a complete connection URL); the two forms are mutually exclusive and "variables" composes only with "key"';

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
      name: "both pinned members",
      value: { key: "prod", url: "wss://api.example.com/v2" },
      want: 'configuration.server carries both "key" and "url": ' + tail,
    },
    {
      name: "neither pinned member",
      value: {},
      want: 'configuration.server carries neither "key" nor "url": ' + tail,
    },
    {
      name: "variables without key",
      value: { variables: { env: "staging" } },
      want: 'configuration.server carries neither "key" nor "url": ' + tail,
    },
    {
      name: "variables with url",
      value: { url: "wss://api.example.com/v2", variables: { env: "staging" } },
      want: 'configuration.server carries "variables" with "url": ' + tail,
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

  it("refuses a supplied value outside the declared enum", () => {
    let message = "";
    try {
      resolveTarget(variableDoc(), undefined, cfg({ key: "tiered", variables: { env: "qa" } }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      'server "tiered": variable "env" value "qa" is not in the declared enum [prod, staging]',
    );
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
