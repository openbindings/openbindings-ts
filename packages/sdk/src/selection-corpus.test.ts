/**
 * Conformance corpus adapter: runs this SDK's binding selection against the
 * interfaces repository's operation-invoker selection corpus unmodified
 * (conformance/selection — the contract's default policy, the
 * context.configuration.selection consumer override, and the explicit
 * `binding` bypass).
 *
 * The corpus is located via OB_INTERFACES_CORPUS or the local-dev sibling
 * path (openbindings/interfaces next to openbindings/openbindings-ts); the
 * suite skips when it is absent.
 *
 * Each fixture drives the real selection path through the public API: the
 * fixture's `supported` set is presented by a stub BindingInvoker (the
 * candidate set is formed from the invoker's registered binding
 * specifications), and `planOperation` — which shares invoke's resolution
 * (OBI-T-12 name resolution, override, pinning, default policy) — reports
 * the selected binding key without invoking anything, exactly as the Go
 * harness observes through PlanOperation.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OperationInvoker } from "./operation-invoker.js";
import { validateDocument } from "./parse.js";
import { BindingNotFoundError } from "./errors.js";
import { InvocationImpl, InvocationError, type Invocation } from "./invocation.js";
import type { BindingInvoker } from "./invokers.js";
import type { BindingInvocationArgs, InvokeOptions } from "./invoker-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function corpusDir(): string | null {
  if (process.env.OB_INTERFACES_CORPUS) return process.env.OB_INTERFACES_CORPUS;
  const dir = resolve(__dirname, "..", "..", "..", "..", "interfaces", "conformance");
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
    kind?: "unknown-binding" | "no-candidate";
  };
}

interface SelectionFixtureFile {
  cluster: string;
  description: string;
  tests: SelectionCase[];
}

/**
 * Presents the fixture's `supported` set as its registered binding
 * specifications. Selection never invokes, so invokeBinding is a guard
 * against accidental invocation, not a mock.
 */
class SelectionSpecStub implements BindingInvoker {
  constructor(private readonly specs: string[]) {}

  bindingSpecs() {
    return this.specs.map((s) => ({ bindingSpec: s }));
  }

  invokeBinding<I, O>(_args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({});
    inv.fireError(
      new InvocationError("ERR_NO_MOCK", "selection corpus fixtures must not invoke bindings"),
    );
    return inv as Invocation<I, O>;
  }
}

// ---------------------------------------------------------------------------
// Selection fixtures
// ---------------------------------------------------------------------------

const dir = corpusDir();

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
      it(`${file.cluster}: ${tc.description}`, () => {
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
          // Both error kinds — unknown explicit binding key and no invocable
          // candidate — surface as the contract-named ERR_BINDING_NOT_FOUND;
          // this SDK raises them synchronously as BindingNotFoundError.
          expect(() => invoker.planOperation(iface, tc.operation, opts)).toThrow(
            BindingNotFoundError,
          );
          return;
        }

        const plan = invoker.planOperation(iface, tc.operation, opts);
        expect(plan.bindingKey).toBe(tc.expected.binding);
      });
    }
  }
});
