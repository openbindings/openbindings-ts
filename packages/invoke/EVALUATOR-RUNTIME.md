# Evaluator runtime contract — official SDK implementation

`TransformEvaluator.evaluate(expression, data, options?)` accepts an optional
`options.signal: AbortSignal`. The existing named-binding extension accepts the
same options after its bindings argument. There is one evaluation API, not a
legacy/cancellable capability pair. The host signal is never expression data.

The operation invoker supplies a signal for both input and output transforms,
including prepared/direct calls. An invocation is exactly one attempt. When
the binding reaches a terminal (a live CONTEXT_REQUIRED included) while an
input transform is in flight, that evaluation is retired through its signal
and the binding's terminal, not an ERR_TRANSFORM_ERROR, surfaces; the
interrupted input is not transformed again, because nothing is replayed. The
existing first-terminal rule and public ERR_CANCELLED behavior remain
authoritative for invocation results.

Evaluators should check before work and at cooperative checkpoints. The SDK
checks again before accepting results. A Promise race that only stops waiting
is not evidence that computation stopped. An AbortSignal cannot preempt a
synchronous builtin or deliver timer events on a blocked event loop.

The native JS candidate accepts host options as the third evaluation argument:

```ts
const evaluator: TransformEvaluator = {
  evaluate(expression, data, options) {
    return jsonata(expression, hostLimits).evaluate(data, undefined, options);
  },
};
```

This is an embedding example for the candidate native API, not a dependency
adoption or built-in SDK evaluator. Limits belong to the host/runtime. Arbitrary
untrusted execution with hard deadlines requires separately qualified
containment. Neither this contract nor the signal changes JSONata syntax,
numerical semantics, Core, binding specifications, or context storage.
