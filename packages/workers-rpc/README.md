# @openbindings/workers-rpc

Cloudflare Workers RPC binding invoker for OpenBindings. Dispatches operation calls from one Worker to a sibling Worker exposing a `WorkerEntrypoint` class via a service binding declared in `wrangler.toml`.

> **Legacy experimental adapter.** This package declares the historical
> `workers-rpc@^1.0.0` token. It is not an implementation of the unpromoted
> `openbindings.workers-rpc@1` candidate, is not one of the six published 0.2
> binding specifications, and does not participate in the release's portable
> synthesis-coverage guarantee.

## Install

```bash
npm install @openbindings/workers-rpc
```

## What it does

Workers RPC is Cloudflare's mechanism for one Worker to call exported methods on another Worker without going through HTTP. Each method on a `WorkerEntrypoint` class is callable as a property on the bound service stub (`env.MY_SERVICE.someMethod(arg)`), with structured-clone serialization across the boundary.

This package wraps that mechanism as a `BindingInvoker`. The dispatch is local to the Cloudflare runtime — there's no network leg, no JSON envelope, no auth header dance. The Cloudflare runtime is the trust boundary; only Workers with the binding declared in their wrangler.toml `[[services]]` block can reach the target.

## Usage

The invoker is constructed per-request because `env` is request-scoped on Workers:

```typescript
import { OperationInvoker, single } from "@openbindings/sdk";
import { WorkersRpcInvoker } from "@openbindings/workers-rpc";
import { createMyServiceInvoker } from "./generated/my-service-invoker.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const base = new OperationInvoker([
      new WorkersRpcInvoker({ binding: env.MY_SERVICE }),
    ]);
    // For workers-rpc the OBI is embedded in the codegen output — the typed
    // invoker defaults to that contract; there is no remote /.well-known
    // endpoint.
    const myService = createMyServiceInvoker(base);

    // One call shape for every cardinality: write input through the handle,
    // read outputs from it. `single` asserts exactly one output (unary).
    const call = myService.someMethod();
    await call.write({ foo: "bar" });
    const result = await single(call.outputs);
    return Response.json(result);
  },
};
```

## Conventions

- **Format token**: `workers-rpc@^1.0.0`
- **Source `location`**: symbolic `workers-rpc://<service-name>`. There's no network dispatch; the URL exists only to identify the source. Any URL works as long as the format token matches.
- **Binding `ref`**: the literal method name on the target `WorkerEntrypoint` class.
- **Source `content`**: not used. Methods are discovered at runtime by property lookup on the binding object.

## Source shape

```json
{
  "sources": {
    "auth": {
      "format": "workers-rpc@^1.0.0",
      "location": "workers-rpc://auth-service"
    }
  },
  "bindings": {
    "mintToken.auth": {
      "operation": "mintToken",
      "source": "auth",
      "ref": "mintToken"
    }
  }
}
```

`workers-rpc://` is a convention indicating a non-HTTP source whose OBI is embedded in the codegen output rather than fetched from `/.well-known/openbindings`. The generated typed invoker binds the embedded contract by default.

## Error model

Errors thrown by the target Worker's RPC method propagate across the binding boundary as `Error` instances (the structured-clone algorithm preserves `name` and `message`). The invoker catches them and terminates the invocation with an `InvocationError` whose `code` is `ERR_EXECUTION_FAILED` — observable on `call.closed` (rejection) or as the throw from iterating `call.outputs`. Custom error subclasses are flattened to the base `Error` shape — if the target wants to communicate structured error info, return a discriminated-union result type from the method instead of throwing.

Pre-dispatch failures terminate before any call is made: an empty `ref` is `ERR_INVALID_REF`; a `ref` that doesn't resolve to a method on the bound entrypoint is `ERR_REF_NOT_FOUND`.

## Streaming

Workers RPC supports streaming via async iterables, but this invoker currently treats every method as unary (one output per call). Streaming support could be added later by detecting iterable returns and emitting one output per item. File an issue if you need it.

## Trust model

There's no auth handshake. The Cloudflare runtime is the trust boundary — only Workers that have the binding declared in their wrangler.toml `[[services]]` block can reach the target. Don't expose a `WorkerEntrypoint` method that you wouldn't want every other Worker in your account to be able to call.

## How it works

1. The invoker receives `BindingInvocationArgs` with a `workers-rpc` source and returns the `Invocation` handle synchronously; the dispatch is scheduled on a microtask.
2. It looks up `args.ref` as a property on the bound service stub (failing with `ERR_INVALID_REF` / `ERR_REF_NOT_FOUND` before any call).
3. It reads the caller's first `write` from the handle and calls the method with it as the single argument (or with no arguments if the input side closed empty), then closes the input side so the caller never has to.
4. The return value is emitted as the one output and the output side closes. Errors thrown by the method terminate the invocation with `ERR_EXECUTION_FAILED`.

Method invocation uses plain property access (`this.binding[methodName](...)`) rather than `Function.prototype.call`. Cloudflare's ServiceStub Proxy returns a dispatch function with the stub captured in a closure; `.call(stub, ...)` makes the runtime try to serialize the stub itself, which fails because ServiceStubs are intentionally non-serializable.

## License

Apache-2.0
