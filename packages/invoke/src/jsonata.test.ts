import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { equal, parse, stringify } from "@openbindings/json";
import type { OBInterface } from "@openbindings/core";
import { createJSONataEvaluator } from "./jsonata.js";
import { createNodeExecutor } from "@openbindings/jsonata/node";
import { OperationInvoker } from "./operation-invoker.js";
import { HandlerBindingInvoker } from "./handler-binding-invoker.js";
import type { TransformEvaluator } from "./invokers.js";

// Use the independently consumable public package, never private backend paths.
// Fresh archive consumers separately prove distribution without source links.
const require = createRequire(import.meta.url);
const worker = createNodeExecutor({timeout: 3000, workers: 2});
const official = createJSONataEvaluator(worker);
afterAll(async () => { await worker.close(); });

interface LanguageCase {
  id: string; expr: string; inputJSON: string;
  expected: {status: "json" | "failure"; json?: string};
}
const corpusRoot = process.env.OB_SPEC_CORPUS;
const languageFile = corpusRoot ? join(corpusRoot,
  ...(basename(corpusRoot) === 'transforms' ? [] : ['transforms']), 'language/scenarios.json') : null;
if ((!languageFile || !existsSync(languageFile)) && process.env.OB_CORPUS_REQUIRED) {
  throw new Error('Current documented transform corpus required; set OB_SPEC_CORPUS to the candidate conformance directory');
}
const languageCases = languageFile && existsSync(languageFile)
  ? (JSON.parse(readFileSync(languageFile, 'utf8')) as {cases:LanguageCase[]}).cases : null;

async function journey(evaluator: TransformEvaluator, expression: string, input: unknown,
  direction: "input" | "output", named = false, schema = false) {
  let received = 0;
  const binding = new HandlerBindingInvoker({bindingSpec:"test.jsonata@1"});
  binding.register({location:"local:echo",selector:"echo",handler:async handle => {
    for await (const value of handle.inputs()) { received++; await handle.emitOutput(value); }
    handle.closeOutput();
  }});
  const iface: OBInterface = {
    openbindings:"0.2.0", operations:{echo:schema ? {input:{}, output:{}} : {}},
    sources:{echo:{bindingSpec:"test.jsonata@1",location:"local:echo"}},
    transforms:{map:expression},
    bindings:{echo:{operation:"echo",source:"echo",selector:"echo",[direction+"Transform"]:named ? {$ref:"#/transforms/map"} : expression}},
  };
  const call = new OperationInvoker([binding],{transformEvaluator:evaluator}).invoke(iface,{key:"echo"});
  const values: unknown[] = [];
  const read = (async () => { try { for await (const value of call.outputs) values.push(value); } catch (error) { return error; } })();
  const closed = call.closed.then(() => undefined,error => error);
  try { await call.write(input); await call.close(); } catch { /* terminal below */ }
  const error: unknown = await closed; const readError: unknown = await read;
  return {values,error,readError,received};
}

describe("Official text executor through real SDK invocation", () => {
  describe.skipIf(languageCases === null)('documented language through input and output transforms', () => {
    it('loads a nonempty documented corpus', () => { expect(languageCases?.length).toBeGreaterThan(0); });
    for (const c of languageCases ?? []) for (const direction of ['input','output'] as const) {
      it(`${c.id} ${direction}`, async () => {
        const result = await journey(official, c.expr, parse(c.inputJSON), direction, true, true);
        if (c.expected.status === 'failure') {
          expect(result.error).toMatchObject({code:'ERR_TRANSFORM_ERROR'});
          expect(result.values).toEqual([]);
          expect(result.received).toBe(direction === 'input' ? 0 : 1);
        } else {
          expect(c.expected.status).toBe('json');
          expect(result.error).toBeUndefined();
          expect(result.values).toHaveLength(1);
          expect(equal(result.values[0],parse(c.expected.json!))).toBe(true);
        }
      });
    }
  });
  for (const direction of ["input","output"] as const) for (const named of [false,true]) for (const schema of [false,true]) {
    for (const raw of ['9007199254740993','0.12345678901234567890123456789','1e400','1e-400','null','{"\\ud800":"\\udfff","isLosslessNumber":true,"_jsonata_lambda":true}']) {
      it(`${direction} named=${named} schema=${schema} preserves ${raw}`,async () => {
        const input = parse(raw);
        const result = await journey(official,'($v := $; $eval("$",$v))',input,direction,named,schema);
        expect(result.error).toBeUndefined(); expect(result.readError).toBeUndefined();
        expect(result.values).toHaveLength(1); expect(equal(result.values[0],input)).toBe(true);
        expect(result.received).toBe(1);
      });
    }
  }
  for (const direction of ["input","output"] as const) {
    it(`${direction} computes exact branch and assigned result`,async () => {
      const result = await journey(official,'id = 9007199254740993 ? 0.1+0.2 : 0',parse('{"id":9007199254740993}'),direction,true,true);
      expect(result.error).toBeUndefined(); expect(stringify(result.values)).toBe('[0.3]');
    });
    for (const expression of ['missing','{"nested":[function(){1}]}','$error("expected")']) {
      it(`${direction} rejects ${expression} at existing failure boundary`,async () => {
        const result = await journey(official,expression,parse('{"id":9007199254740993}'),direction);
        expect(result.error).toMatchObject({code:"ERR_TRANSFORM_ERROR"});
        expect(result.readError).toMatchObject({code:"ERR_TRANSFORM_ERROR"}); expect(result.values).toEqual([]);
        expect(result.received).toBe(direction === 'input' ? 0 : 1);
      });
    }
  }
  it('admits null variables and rejects host callbacks before the worker',async () => {
    expect(await official.evaluateWithBindings('$x',{}, {x:null})).toBeNull();
    await expect(official.evaluateWithBindings('$x()',{}, {x:() => 1})).rejects.toThrow();
  });
  it('propagates pre-cancellation without converting or running',async () => {
    const controller = new AbortController(); controller.abort(new Error('caller stop'));
    await expect(official.evaluate('$',parse('9007199254740993'),{signal:controller.signal})).rejects.toThrow('caller stop');
  });
});

describe('Real alternative evaluator through the same generic seam', () => {
  // Existing jsonata-js 2.1.1 remains a dev-only reference, not a second official
  // runtime. Text is deliberately converted to native binary64 on this lane.
  const coreRequire = createRequire(require.resolve('@openbindings/core'));
  const reference = coreRequire('jsonata') as (expression:string) => {evaluate(input:unknown):Promise<unknown>};
  function plainResult(value: unknown): unknown {
    // Materialize this engine's sequence arrays before crossing the adapter
    // boundary. Validate first; JSON.stringify would hide functions/undefined.
    if (Array.isArray(value)) return Array.from(value,plainResult);
    if (value === null || typeof value !== 'object') {
      stringify(value); // common JSON-domain check, not numerical policy
      return value;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('non-JSON alternative result');
    const output: Record<string,unknown> = Object.create(null) as Record<string,unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value,key)!;
      if (typeof key !== 'string' || !property.enumerable || !('value' in property)) throw new TypeError('non-JSON alternative property');
      output[key] = plainResult(property.value);
    }
    return output;
  }
  const alternative: TransformEvaluator = {async evaluate(expression,data,options) {
    options?.signal?.throwIfAborted();
    const input: unknown = JSON.parse(stringify(data));
    const value = await reference(expression).evaluate(input);
    options?.signal?.throwIfAborted();
    return plainResult(value);
  }};
  for (const direction of ['input','output'] as const) {
    for (const raw of ['null','"text"','[[],[1],false]','{"id":7}']) {
      it(`${direction} common-domain ${raw}`,async () => {
        const value = parse(raw); const result = await journey(alternative,'$',value,direction,true,true);
        expect(result.error).toBeUndefined(); expect(equal(result.values[0],value)).toBe(true);
      });
    }
    it(`${direction} makes the lower-fidelity conversion observable, not an injection ban`,async () => {
      const value = parse('9007199254740993');
      const result = await journey(alternative,'$',value,direction);
      expect(result.error).toBeUndefined(); expect(stringify(result.values)).toBe('[9007199254740992]');
      const exact = await journey(official,'$',value,direction);
      expect(exact.error).toBeUndefined(); expect(stringify(exact.values)).toBe('[9007199254740993]');
    });
    it(`${direction} materializes sequence metadata at its own adapter boundary`,async () => {
      const result = await journey(alternative,'items.{"key":id}',{items:[{id:1},{id:2}]},direction,true,true);
      expect(result.error).toBeUndefined();
      expect(stringify(result.values)).toBe('[[{"key":1},{"key":2}]]');
    });
    for (const expression of ['missing','{"nested":[function(){1}]}','$error("expected")']) {
      it(`${direction} retains common result/error guards for ${expression}`,async () => {
        const result = await journey(alternative,expression,{},direction);
        expect(result.error).toMatchObject({code:'ERR_TRANSFORM_ERROR'}); expect(result.values).toEqual([]);
      });
    }
  }
});
