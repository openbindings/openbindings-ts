/**
 * BindingInvoker implementation for the openbindings.operation-graph format.
 *
 * Construction takes an OperationInvoker so operation nodes can recurse into
 * other operations on the same OBI through it. The recursive dependency is
 * resolved post-construction via OperationInvoker.addBindingInvoker.
 */
import type {
  BindingInvocationArgs,
  BindingInvoker,
  FormatInfo,
  Invocation,
  OperationInvoker,
} from "@openbindings/sdk";
import {
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  InvocationError,
  InvocationImpl,
} from "@openbindings/sdk";
import type { Document, Graph } from "./types.js";
import { parseDocument } from "./types.js";
import { validate } from "./validate.js";
import { SchemaCache } from "./state.js";
import { Engine } from "./engine.js";
import { FORMAT_TOKEN } from "./constants.js";

/** BindingInvoker for operation-graph source documents. */
export class OperationGraphInvoker implements BindingInvoker {
  private readonly invoker: OperationInvoker;
  private readonly docCache = new Map<string, Document>();
  private readonly schemas = new SchemaCache();

  constructor(invoker: OperationInvoker) {
    this.invoker = invoker;
  }

  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "OpenBindings operation graphs" }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      this.run(args, inv).catch((err) => {
        inv.fireError(asInvocationError(err));
      });
    });
    return inv as Invocation<I, O>;
  }

  /** Drives one graph invocation behind the handle. */
  private async run(
    args: BindingInvocationArgs,
    inv: InvocationImpl<unknown, unknown>,
  ): Promise<void> {
    let doc: Document;
    try {
      doc = this.loadDocument(args.source.location, args.source.content);
    } catch (err) {
      inv.fireError(new InvocationError(ERR_SOURCE_LOAD_FAILED, (err as Error).message));
      return;
    }

    const graph: Graph | undefined = doc.graphs?.[args.ref];
    if (!graph) {
      inv.fireError(
        new InvocationError(
          ERR_REF_NOT_FOUND,
          `operation graph "${args.ref}" not found in document`,
        ),
      );
      return;
    }

    // Validate the graph BEFORE touching the caller's input channel so an
    // invalid graph fails without consuming a write (and without parking on
    // a read the caller may never satisfy). The engine re-validates, which
    // is a no-op for graphs that pass here.
    let opKeys: Set<string> | undefined;
    if (args.interface) {
      opKeys = new Set(Object.keys(args.interface.operations));
    }
    try {
      validate(graph, opKeys);
    } catch (err) {
      inv.fireError(new InvocationError(ERR_VALIDATION_FAILED, (err as Error).message));
      return;
    }

    // A graph takes at most one initial event from the caller's input
    // channel. When the call arrived through the operation layer (binding
    // present) for an operation that declares no input (no inputSchema),
    // the caller never writes: close input on entry and seed the graph
    // with undefined. Otherwise this is a unary binding: read the first
    // input, then close input so the caller never has to.
    let input: unknown;
    if (args.binding !== undefined && args.inputSchema === undefined) {
      void inv.closeInput();
    } else {
      input = await readFirst(inv.inputs());
      void inv.closeInput();
    }

    const engine = new Engine({
      graph,
      invoker: this.invoker,
      args,
      input,
      transform: this.invoker.transformEvaluator,
      schemas: this.schemas,
    });
    await engine.run(inv);
  }

  private loadDocument(location: string | undefined, content: unknown): Document {
    if (location && content == null) {
      const cached = this.docCache.get(location);
      if (cached) return cached;
    }

    let parsed: unknown;
    if (content == null) {
      throw new Error("no content or location provided");
    }
    if (typeof content === "string") {
      parsed = JSON.parse(content);
    } else if (content instanceof Uint8Array) {
      parsed = JSON.parse(new TextDecoder().decode(content));
    } else if (typeof content === "object") {
      parsed = content;
    } else {
      parsed = structuredClone(content);
    }
    const doc = parseDocument(parsed);

    if (location) this.docCache.set(location, doc);
    return doc;
  }
}

/** Reads the first input message, or undefined when input closes with none. */
async function readFirst<T>(it: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of it) return v;
  return undefined;
}

function asInvocationError(err: unknown): InvocationError {
  if (err instanceof InvocationError) return err;
  return new InvocationError(
    ERR_RUNTIME,
    err instanceof Error ? err.message : String(err),
  );
}
