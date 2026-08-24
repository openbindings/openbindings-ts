/**
 * Conformance corpus adapter: runs this SDK's binding selection against the
 * interfaces repository's operation-invoker selection corpus unmodified
 * (conformance/selection — explicit caller choice, sole-candidate inference,
 * and ambiguity refusal).
 *
 * The corpus is located via OB_INTERFACES_CORPUS or the local-dev sibling
 * path (openbindings/interfaces next to openbindings/openbindings-ts); the
 * suite skips when it is absent.
 *
 * Each fixture drives the real selection path through the public API: the
 * fixture's `supported` set is presented by a stub BindingInvoker (the
 * candidate set is formed from the invoker's registered binding
 * specifications) and `invoke` runs the shared resolution (OBI-T-12 name
 * resolution, ordered choice, pinning, and ambiguity refusal). Selection is decided
 * before the binding layer runs, so the selected key is observed via the
 * invocation-site carriage the invoke path stamps on the binding-layer args
 * (`args.site.bindingKey`) — public contract surface, no test seam added.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OperationInvoker } from "./operation-invoker.js";
import { operationSignature } from "./operation-signature.js";
import { validateDocument } from "@openbindings/core";
import { BindingNotFoundError, BindingSelectionRequiredError } from "./errors.js";
import { InvocationImpl, type Invocation } from "./invocation.js";
import type { BindingInvoker } from "./invokers.js";
import type { BindingInvocationArgs, InvokeOptions } from "./invoker-types.js";
import type { InvokeSite } from "./hooks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function corpusDir(): string | null {
  const dir =
    process.env.OB_INTERFACES_CORPUS ??
    resolve(__dirname, "..", "..", "..", "..", "interfaces", "conformance");
  return existsSync(dir) ? dir : null;
}

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

interface SelectionCase {
  description: string;
  document: Record<string, unknown>;
  operation: string;
  supported: string[];
  selection?: string[];
  binding?: string;
  expected: {
    binding?: string;
    error?: boolean;
    kind?: "unknown-binding" | "no-candidate" | "ambiguous";
  };
}

interface SelectionFixtureFile {
  cluster: string;
  description: string;
  tests: SelectionCase[];
}

/**
 * Presents the fixture's `supported` set as its registered binding
 * specifications and records the invocation site of the binding it is
 * handed. Selection is decided before the binding layer runs, so the stub
 * completes the invocation immediately without emitting.
 */
class SelectionSpecStub implements BindingInvoker {
  lastSite: InvokeSite | undefined;

  constructor(private readonly specs: string[]) {}

  checkBindingSpecs(bindingSpecs: readonly string[]) {
    const supported = new Set(this.specs);
    return [...new Set(bindingSpecs)].map(bindingSpec => ({ bindingSpec, supported: supported.has(bindingSpec) }));
  }

  bindingSpecs() {
    return this.specs.map((s) => ({ bindingSpec: s }));
  }

  invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
    this.lastSite = args.site;
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      void inv.closeInput();
      inv.closeOutput();
    });
    return inv as Invocation<I, O>;
  }
}

// ---------------------------------------------------------------------------
// Selection fixtures
// ---------------------------------------------------------------------------

const dir = corpusDir();

// OB_CORPUS_REQUIRED (set in CI) turns a missing corpus into a hard failure
// so a mis-wired path or missing checkout turns CI red instead of silently
// green; unset (local dev) the suite still skips.
if (!dir && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "interfaces conformance corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_INTERFACES_CORPUS to the interfaces repo's conformance dir",
  );
}

describe.skipIf(!dir)("conformance corpus: operation-invoker binding selection", () => {
  if (!dir) return;
  const selDir = join(dir, "selection");
  const files: SelectionFixtureFile[] = readdirSync(selDir)
    .filter((n) => n.endsWith(".json") && n !== "fixture.schema.json")
    .sort()
    .map((n) => JSON.parse(readFileSync(join(selDir, n), "utf8")) as SelectionFixtureFile);

  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    for (const tc of file.tests) {
      it(`${file.cluster}: ${tc.description}`, async () => {
        // Fixture documents are complete, valid OBIs; run them through the
        // SDK's real document validation. A failure here is a corpus defect.
        const iface = validateDocument(JSON.stringify(tc.document));

        const stub = new SelectionSpecStub(tc.supported);
        const invoker = new OperationInvoker([stub]);

        const opts: InvokeOptions = {};
        if (tc.binding !== undefined) opts.bindingKey = tc.binding;
        if (tc.selection !== undefined) {
          opts.context = { configuration: { selection: tc.selection } };
        }

        if (tc.expected.error) {
          const ErrorType =
            tc.expected.kind === "ambiguous"
              ? BindingSelectionRequiredError
              : BindingNotFoundError;
          expect(() => invoker.invoke(iface, operationSignature(tc.operation), opts)).toThrow(
            ErrorType,
          );
          return;
        }

        const call = invoker.invoke(iface, operationSignature(tc.operation), opts);
        await call.closed;
        expect(stub.lastSite?.bindingKey).toBe(tc.expected.binding);
      });
    }
  }
});
