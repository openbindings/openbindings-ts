# Exact JSON Schema adapter

Shared implementation-level numeric adaptation over the pinned, maintained
`json-schema-library` evaluator. It has no OpenBindings Core dependency and can
be used by standalone clients.

```ts
import { compileSchema, EXACT_DRAFT_2020 } from "@openbindings/json-schema";
import { parseJSON } from "@openbindings/json";

const schema = compileSchema(parseJSON('{"const":9007199254740993}'), {
  drafts: [EXACT_DRAFT_2020],
});
schema.validate(parseJSON("9007199254740993")).valid; // true
schema.validate(parseJSON("9007199254740992")).valid; // false
```

The exact draft adapts numeric dispatch, counts, bounds, const/enum/uniqueItems
and diagnostics. The upstream evaluator still owns references, applicators,
conditional branches, annotations and coverage. Formats are annotation-only;
this is not a claim to implement every optional JSON Schema vocabulary.
Unresolvable references and numeric capability refusals must not be treated as
ordinary valid/invalid verdicts by callers.

Both ESM and CJS artifacts privately bundle the corrected evaluator. No consumer
patch configuration is required. The declared `json-schema-library` dependency
supplies its exported types; use this package's `compileSchema` for the corrected
runtime. See `THIRD_PARTY_NOTICES.md` and the repository's
`third_party/json-schema-library` for source patches and reproduction instructions.

This is an SDK quality policy, not an amendment to any OpenBindings specification.
Final package/runtime/resource qualification and JSONata activation are separate
gates; see the continuation audit before making release claims.
