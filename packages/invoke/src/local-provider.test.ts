import { describe, expect, it } from "vitest";
import type { OBInterface } from "@openbindings/core";
import { prepareInterface } from "@openbindings/core";
import { single } from "./invocation.js";
import {
  ERR_INPUT_CLOSED,
  ERR_MISSING_INPUT,
  ERR_OPERATION_VALIDATION_FAILED,
  ERR_TOO_MANY_INPUTS,
} from "./errcodes.js";
import { CompositionSession } from "./composition-session.js";
import { localUnary, prepareLocalProvider } from "./local-provider.js";

const IFACE: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    create: {
      input: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  dependencies: {
    creation: { operation: "create", bindingSpecs: ["example.local@1"] },
  },
  sources: {
    local: { bindingSpec: "example.local@1", location: "app://tasks" },
  },
  bindings: {
    createLocal: { operation: "create", source: "local", selector: "create" },
  },
};

describe("prepareLocalProvider", () => {
  it("registers by binding key and preserves native reference identity", async () => {
    let observed: unknown;
    const provider = await prepareLocalProvider({
      key: "localTasks",
      interface: IFACE,
      implementations: {
        createLocal: localUnary<{ title: string }, { id: string }>(input => {
          observed = input;
          return { id: `local:${input.title}` };
        }),
      },
    });
    const consumer = await prepareInterface(IFACE);
    const result = await new CompositionSession({
      consumer,
      providers: [{ provider }],
    }).resolve<{ title: string }, { id: string }>("creation");
    expect(result.status).toBe("available");
    if (result.status !== "available") return;

    const input = { title: "draft" };
    const invocation = result.route.invoke();
    await invocation.write(input);
    await expect(single(invocation.outputs)).resolves.toEqual({ id: "local:draft" });
    expect(observed).toBe(input);
  });

  it("evaluates a local prerequisite once per invocation on both execution paths", async () => {
    let directPreflights = 0;
    const direct = await prepareLocalProvider({
      key: "direct-preflight",
      interface: IFACE,
      implementations: {
        createLocal: localUnary<{ title: string }, { id: string }>(
          input => ({ id: input.title }),
          { prepare: () => { directPreflights++; return null; } },
        ),
      },
    });
    const consumer = await prepareInterface(IFACE);
    const directResult = await new CompositionSession({
      consumer,
      providers: [{ provider: direct }],
    }).resolve<{ title: string }, { id: string }>("creation");
    if (directResult.status !== "available") throw new Error(directResult.status);
    const directCall = directResult.route.invoke();
    await directCall.write({ title: "direct" });
    await expect(single(directCall.outputs)).resolves.toEqual({ id: "direct" });
    expect(directPreflights).toBe(1);

    let resolvedPreflights = 0;
    const resolved = await prepareLocalProvider({
      key: "resolved-preflight",
      interface: IFACE,
      implementations: {
        createLocal: localUnary<{ title: string }, { id: string }>(
          (input, args) => ({
            id: `${String(args.context?.["bearerToken"])}:${input.title}`,
          }),
          {
            prepare: args => {
              resolvedPreflights++;
              return args.context?.["bearerToken"]
                ? null
                : {
                    target: "local:test",
                    alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
                  };
            },
          },
        ),
      },
      operationInvoker: {
        contextResolver: () => ({ bearerToken: "resolved" }),
      },
    });
    const resolvedResult = await new CompositionSession({
      consumer,
      providers: [{ provider: resolved }],
    }).resolve<{ title: string }, { id: string }>("creation");
    if (resolvedResult.status !== "available") throw new Error(resolvedResult.status);
    const resolvedCall = resolvedResult.route.invoke();
    await resolvedCall.write({ title: "value" });
    await expect(single(resolvedCall.outputs)).resolves.toEqual({ id: "resolved:value" });
    expect(resolvedPreflights).toBe(1);
  });

  it("does not advertise same-spec bindings without implementations", async () => {
    const document = structuredClone(IFACE);
    document.bindings!.other = {
      operation: "create",
      source: "local",
      selector: "other",
    };
    const provider = await prepareLocalProvider({
      key: "partial",
      interface: document,
      implementations: {
        createLocal: localUnary(input => input),
      },
    });
    expect(provider.realization("createLocal")?.supported).toBe(true);
    expect(provider.realization("other")?.supported).toBe(false);
  });

  it("fails wiring early for unknown binding keys", async () => {
    await expect(prepareLocalProvider({
      key: "bad",
      interface: IFACE,
      implementations: { missing: localUnary(input => input) },
    })).rejects.toThrow(/unknown binding/);
  });

  it("uses ordinary invocation failures for zero, excess, and invalid unary values", async () => {
    const provider = await prepareLocalProvider({
      key: "cardinality",
      interface: IFACE,
      implementations: {
        createLocal: localUnary<{ title: string }, { id: string }>(() => ({ id: "ok" })),
      },
    });
    const consumer = await prepareInterface(IFACE);
    const result = await new CompositionSession({
      consumer,
      providers: [{ provider }],
    }).resolve<{ title: string }, { id: string }>("creation");
    if (result.status !== "available") throw new Error(result.status);

    const missing = result.route.invoke();
    await missing.close();
    await expect(missing.closed).rejects.toMatchObject({
      code: ERR_MISSING_INPUT,
    });

    const excess = result.route.invoke();
    await excess.write({ title: "first" });
    let secondFailure: unknown;
    await excess.write({ title: "second" }).catch(error => {
      secondFailure = error;
    });
    if (secondFailure) {
      expect(secondFailure).toMatchObject({ code: ERR_INPUT_CLOSED });
      await expect(single(excess.outputs)).resolves.toEqual({ id: "ok" });
    } else {
      await expect(excess.closed).rejects.toMatchObject({
        code: ERR_TOO_MANY_INPUTS,
      });
      await expect(single(excess.outputs)).rejects.toMatchObject({
        code: ERR_TOO_MANY_INPUTS,
      });
    }

    const invalid = result.route.invoke();
    await expect(invalid.write({ title: 42 } as unknown as { title: string }))
      .rejects.toMatchObject({
        code: ERR_OPERATION_VALIDATION_FAILED,
      });
  });
});
