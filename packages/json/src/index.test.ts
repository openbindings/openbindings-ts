import { describe, it, expect } from "vitest";
import { JSONNumber, isJSONNumber, parseJSON, stringifyJSON, cloneJSON, assertJSONValue } from "./index.js";

describe("exact JSON carriage", () => {
  for (const token of ["9007199254740993", "9223372036854775807", "18446744073709551615", "0.1", "0.10000000000000002", "1.234567890123456789", "1e400", "-1e400", "1e-400", "5e-324", "1e999999999999999999999999"]) {
    it(`preserves ${token}`, () => {
      const value=parseJSON(token);
      expect(value).toBeInstanceOf(JSONNumber);
      expect(stringifyJSON(value)).toBe(token);
      expect(stringifyJSON(cloneJSON({nested:[value]}))).toBe(`{"nested":[${token}]}`);
      expect(()=>Number(value)).toThrow();
    });
  }
  it("keeps exact native integers ergonomic",()=>{expect(parseJSON("42")).toBe(42)});
  it("preserves member names and number-marker lookalikes",()=>{
    const raw='{"__proto__":{"polluted":true},"isLosslessNumber":true,"value":"123","constructor":"ordinary","toString":7}';
    const value=parseJSON(raw);
    expect(Object.hasOwn(value as object,"__proto__")).toBe(true);
    expect(stringifyJSON(value)).toBe(raw);
  });
  it("preserves null, missing, array nesting and Unicode",()=>{
    const raw='{"present":null,"items":[[],[false,"é 😀"]]}';
    expect(stringifyJSON(parseJSON(raw))).toBe(raw);
    expect(Object.hasOwn(parseJSON(raw) as object,"absent")).toBe(false);
  });
  it("rejects non-JSON host values before serialization",()=>{
    const cycle: unknown[]=[];cycle.push(cycle);
    for(const invalid of [undefined,()=>1,{nested:()=>1},{x:undefined},NaN,Infinity,[,],cycle,new Date()]) {
      expect(()=>stringifyJSON(invalid)).toThrow();
      expect(()=>cloneJSON(invalid)).toThrow();
    }
    const withGetter={get x(){throw Error("getter invoked")}};
    expect(()=>assertJSONValue(withGetter)).toThrow("not a JSON member");
    expect(()=>cloneJSON(withGetter)).toThrow("not a JSON member");
  });
  it("does not freeze a universal boundary acceptance policy",()=>{
    expect(parseJSON('{"a":1,"a":2}')).toEqual({a:2});
    expect(()=>parseJSON('1 2')).toThrow();
    expect(()=>parseJSON('01')).toThrow();
  });
  it("does not recognize fabricated numeric prototypes",()=>{
    const forged: unknown=Object.create(JSONNumber.prototype);
    expect(isJSONNumber(forged)).toBe(false);
    expect(()=>stringifyJSON(forged)).toThrow();
  });
  it("does not call number subclass hooks",()=>{
    let calls=0;
    class HookNumber extends JSONNumber { toJSON(){calls++;return "replaced"} }
    expect(stringifyJSON(new HookNumber("0.1"))).toBe("0.1");
    expect(calls).toBe(0);
  });
  it("rejects array metadata without invoking hooks or getters",()=>{
    let calls=0;
    const hook=[];Object.defineProperty(hook,"toJSON",{get(){calls++;return ()=>"replaced"}});
    const extra=Object.assign([1],{metadata:true});
    const symbol=Object.assign([1],{[Symbol("hidden")]:true});
    for(const value of [hook,extra,symbol]) expect(()=>stringifyJSON(value)).toThrow();
    expect(calls).toBe(0);
  });
  it("serializes detached plain data without inherited hooks",()=>{
    let calls=0;
    Object.defineProperty(Array.prototype,"toJSON",{configurable:true,value(){calls++;return "replaced"}});
    try{expect(stringifyJSON({a:[new JSONNumber("0.1")]})).toBe('{"a":[0.1]}');expect(calls).toBe(0);}
    finally{Reflect.deleteProperty(Array.prototype,"toJSON");}
  });
  it("detaches aliases without confusing them with cycles",()=>{
    const shared={n:new JSONNumber("0.1")};
    const result=cloneJSON([shared,shared]) as {n:JSONNumber}[];
    expect(result[0]).not.toBe(shared);expect(result[0]).not.toBe(result[1]);
    expect(Object.isFrozen(result[0]!.n)).toBe(true);
  });
  it("clones ordinary object/array surfaces without hooks or text coercion",()=>{
    let calls=0;
    const number=new JSONNumber("9007199254740993");
    const source=parseJSON('{"__proto__":{"safe":true},"items":[0.1,null],"toJSON":7}');
    Object.defineProperty(Array.prototype,"toJSON",{configurable:true,value(){calls++;throw Error("hook")}});
    try {
      const result=cloneJSON({source,number,native:0.1,zero:-0}) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(result.source).not.toBe(source);
      const nested=result.source as Record<string, unknown>;
      expect(Object.hasOwn(nested,"__proto__")).toBe(true);
      expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(nested.items)).toBe(Array.prototype);
      expect(result.number).toBe(number); // immutable authentic carrier is safe to share
      expect(result.native).toBe(0.1);
      expect(Object.is(result.zero,-0)).toBe(false);
      expect(calls).toBe(0);
    } finally {Reflect.deleteProperty(Array.prototype,"toJSON");}
  });
});
