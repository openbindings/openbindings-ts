import { describe, it, expect } from "vitest";
import { JSONValueSet, parseJSON, stringifyJSON, JSONCapabilityError } from "./index.js";

describe("owned exact value index",()=>{
  it("preserves first spellings, nested values and ownership",()=>{
    const raw='{"__proto__":{"n":9007199254740993}}';
    const value=parseJSON(raw) as Record<string,unknown>;
    const set=new JSONValueSet([parseJSON("0.10"),parseJSON("1e-1"),value,"0.1",null]);
    expect(set.size).toBe(4);
    for(const token of ["0.1","0.100","1e-1"])expect(set.has(parseJSON(token))).toBe(true);
    expect(set.has(parseJSON("0.10000000000000001"))).toBe(false);
    expect(stringifyJSON([...set][0])).toBe("0.10");
    value.__proto__=false;([ ...set ][1] as Record<string,unknown>).__proto__=false;
    expect(set.has(parseJSON(raw))).toBe(true);
    expect(()=>set.has(parseJSON("1e10001"))).toThrow(JSONCapabilityError);
  });
  it("verifies exact equality even if the accelerator collides",()=>{
    const set=new JSONValueSet();
    (set as unknown as {key:()=>string}).key=()=>"collision";
    set.add(parseJSON("9007199254740993"));set.add("9007199254740993");
    expect(set.has(parseJSON("9007199254740992"))).toBe(false);
    expect(set.has(parseJSON("9007199254740993.0"))).toBe(true);
    expect(set.has("9007199254740993")).toBe(true);
    expect(set.add("9007199254740993")).toBe(false);
    set.add(null);set.add(false);
    expect(set.has(null)).toBe(true);expect(set.has(false)).toBe(true);
    expect([...set]).toEqual([parseJSON("9007199254740993"),"9007199254740993",null,false]);
  });
});
