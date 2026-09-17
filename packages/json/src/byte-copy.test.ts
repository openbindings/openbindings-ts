import {describe,it,expect} from "vitest";
import {bytesValue,borrowBytes,retain,retainFrom,retainedValueAccess,type ValueAccess} from "./values.js";

describe("optional trusted byte destination copy",()=>{
  for(const size of [0,1,2,3,4,4096,1048576])it(`copies ${size} bytes once and keeps lifetimes independent`,()=>{
    const original=new Uint8Array(size+4).fill(99),slice=original.subarray(2,size+2);slice.fill(37);
    const input=bytesValue(slice);
    const before=input.costs.bytesCopied,output=retainFrom(input,retainedValueAccess);
    expect(input.costs.bytesCopied-before).toBe(size);expect(output.costs.bytesCopied).toBe(0);
    original.fill(99);input.dispose();
    // Check every byte without the assertion library recursively comparing a
    // million indexed object properties. Keep the normal test time limit.
    const first=output.bytes()!;expect(first).toBeInstanceOf(Uint8Array);expect(first.byteLength).toBe(size);
    expect(first.every(byte=>byte===37)).toBe(true);first.fill(88);
    const second=output.bytes()!;expect(second).toBeInstanceOf(Uint8Array);expect(second.byteLength).toBe(size);
    expect(second.every(byte=>byte===37)).toBe(true);
    expect(output.costs.base64Encodes).toBe(0);expect(output.costs.jsonSerializations).toBe(0);
  });
  it("snapshots borrowed input at the copy boundary",()=>{
    const bytes=new Uint8Array([1,2,3]),input=borrowBytes(bytes),output=retainFrom(input,retainedValueAccess);
    bytes.fill(9);input.dispose();expect(output.bytes()).toEqual(new Uint8Array([1,2,3]));
  });
  it("keeps the old defensive fallback and old metadata-free adapters",()=>{
    const input=bytesValue(new Uint8Array([1,2,3]));
    const old={...retainedValueAccess,copyBytesInto:undefined};
    const result=retainFrom(input,old);expect(result.costs.bytesCopied).toBe(3);
    expect(retainFrom(input,{...old,byteLength:undefined}).bytes()).toEqual(new Uint8Array([1,2,3]));
    expect(result.bytes()).toEqual(new Uint8Array([1,2,3]));
  });
  it("does not negotiate inherited capabilities or invoke capability getters",()=>{
    const input=bytesValue(new Uint8Array([1,2,3]));
    const {copyBytesInto:copy,...old}=retainedValueAccess;expect(copy).toBeTypeOf("function");
    const prototype={copyBytesInto(){throw Error("inherited capability");}};
    expect(retainFrom(input,Object.assign(Object.create(prototype) as ValueAccess<typeof input>,old)).bytes()).toEqual(new Uint8Array([1,2,3]));
    Object.defineProperty(old,"copyBytesInto",{get(){throw Error("capability getter");}});
    expect(retainFrom(input,old).bytes()).toEqual(new Uint8Array([1,2,3]));
    let imported;
    Object.defineProperty(Object.prototype,"value",{value(){throw Error("descriptor prototype");},configurable:true});
    try { imported=retainFrom(input,old); }
    finally { Reflect.deleteProperty(Object.prototype,"value"); }
    expect(imported.bytes()).toEqual(new Uint8Array([1,2,3]));
  });
  it("validates bounds before allocation or copy, and never retries a failed copy",()=>{
    const input=bytesValue(new Uint8Array([1,2,3]));let calls=0;
    const access={...retainedValueAccess,copyBytesInto(){calls++;return 3;},bytes(){throw Error("fallback must not run");}};
    for(const length of [-1,NaN,Infinity,0.5])expect(()=>retainFrom(input,{...access,byteLength:()=>length})).toThrow(/byte length/);
    expect(()=>retainFrom(input,access,{maxBytes:2})).toThrow(/budget/);
    expect(()=>retainFrom(input,{...access,length:()=>5})).toThrow(/logical length/);expect(calls).toBe(0);
    for(const result of [undefined,NaN,-1,2,4])expect(()=>retainFrom(input,{...access,copyBytesInto(){calls++;return result;}})).toThrow(/copy length/);
    const failure=Error("copy failed");expect(()=>retainFrom(input,{...access,copyBytesInto(){throw failure;}})).toThrow(failure);
    expect(()=>retainFrom(input,{...access,copyBytesInto(_v,destination){structuredClone(destination.buffer,{transfer:[destination.buffer]});return 3;}})).toThrow();
  });
  it("validates advertised old byte storage without forcing a string",()=>{
    const input=bytesValue(new Uint8Array([1,2,3])),old={...retainedValueAccess,copyBytesInto:undefined};
    expect(()=>retainFrom(input,{...old,bytes:()=>undefined})).toThrow(/Missing byte storage/);
    expect(()=>retainFrom(input,{...old,bytes:()=>new Uint8Array(2)})).toThrow(/storage length/);
  });
  it("authenticates senders and never exposes private backing to a destination",()=>{
    const input=bytesValue(new Uint8Array([1,2,3])),copy=retainedValueAccess.copyBytesInto!;
    expect(copy(retain("ordinary"),new Uint8Array())).toBeUndefined();
    expect(()=>copy({} as never,new Uint8Array(3))).toThrow(/authenticated/);
    expect(()=>copy(input,new Uint8Array(2))).toThrow(/length/);
    const destination=new Uint8Array(5).fill(99);expect(copy(input,destination.subarray(1,4))).toBe(3);
    expect(destination).toEqual(new Uint8Array([99,1,2,3,99]));destination.fill(77);expect(input.bytes()).toEqual(new Uint8Array([1,2,3]));
    input.dispose();expect(()=>copy(input,new Uint8Array(3))).toThrow(/disposed/);
  });
});
