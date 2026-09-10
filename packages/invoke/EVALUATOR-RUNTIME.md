# Evaluator runtime contract — official SDK implementation

`TransformEvaluator.evaluate(expression, data, options?)` accepts an optional
`options.signal: AbortSignal`. The existing named-binding extension accepts the
same options after its bindings argument. There is one evaluation API, not a
legacy/cancellable capability pair. The host signal is never expression data.

The operation invoker supplies a signal for both input and output transforms,
including prepared/direct calls. Retried attempts have separate cancellation
state. Retiring an interrupted input transform restores its raw input for retry;
successfully transformed replay values are not transformed again. Internal
retirement is not an ERR_TRANSFORM_ERROR. The existing first-terminal rule and
public ERR_CANCELLED behavior remain authoritative for invocation results.

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
