import {describe,it,expect,vi} from "vitest";
import {runInNewContext} from "node:vm";
import rawJSON from "core-js-pure/actual/json/raw-json.js";
import {JSONNumber,parseJSON,stringifyJSON} from "./index.js";
import {retain,parseRetainedJSON,bytesValue,borrowBytes,transferBytes,recordValue,arrayValue,retainFrom,retainedValueAccess,isRetainedValue,type ValueAccess} from "./values.js";

describe("direct retained JSON parsing",()=>{
  it.each(['null','true','0','-0','0.10000000000000001','9007199254740993','1e9999','"😀é"','[]','{}','{"a":[1,{"n":0.3}],"__proto__":9}','{"a":{"removed":1},"a":2}'])("shares exact parser semantics for %s",text=>{
    const value=parseRetainedJSON(text), expected=retain(parseJSON(text));
    expect(value.text()).toBe(expected.text()); expect(value.size()).toEqual(expected.size());
    value.dispose(); expected.dispose();
  });
  it("enforces the same depth, occurrence and scalar/key budgets",()=>{
    for (const [text,options] of [['[[0]]',{maxDepth:1}],['[0,0]',{maxNodes:2}],['{"a":"b"}',{maxBytes:3}]] as const) {
      expect(()=>parseRetainedJSON(text,options)).toThrow(RangeError);
      expect(()=>retain(parseJSON(text),options)).toThrow(RangeError);
    }
    expect(parseRetainedJSON('{"a":[0]}',{maxDepth:2,maxNodes:3,maxBytes:4}).text()).toBe('{"a":[0]}');
    expect(parseRetainedJSON('{"a":[1,2,3],"a":0}',{maxNodes:2}).text()).toBe('{"a":0}');
    expect(()=>parseRetainedJSON('[1,]')).toThrow(SyntaxError);
  });
  it("keeps native exports independent, including child handles after disposal",()=>{
    const value=parseRetainedJSON('{"a":[1]}'), child=value.get("a")!;
    const exported=value.native() as {a:number[]}; exported.a[0]=9; value.dispose();
    expect(child.native()).toEqual([1]); child.dispose();
  });
});

describe("retained logical values",()=>{
  it("retains exact numbers and distinguishes absent, null, arrays and Unicode",()=>{
    const value=retain(parseJSON('{"n":9007199254740993,"nil":null,"list":[0.1,"😀é"]}'));
    expect(value.get("n")!.numberToken()).toBe("9007199254740993");
    expect(value.get("absent")).toBeUndefined();expect(value.get("nil")!.kind).toBe("null");
    expect(value.get("list")!.get(1)!.length).toBe(2);
    expect(value.get("list")!.get("0")).toBeUndefined();expect(value.get("list")!.get(-1)).toBeUndefined();
    expect(value.text()).toBe('{"n":9007199254740993,"nil":null,"list":[0.1,"😀é"]}');
  });
  it("owns source objects and all returned projections",()=>{
    const source={a:[{b:1}]};const value=retain(source);source.a[0]!.b=9;
    const view=value.json() as typeof source;view.a[0]!.b=8;
    expect(value.get("a")!.get(0)!.get("b")!.scalar()).toBe(1);
  });
  it("keeps prototype member names as data",()=>{
    const value=retain(parseJSON('{"__proto__":{"polluted":true},"constructor":7}'));
    expect(value.keys()).toEqual(["__proto__","constructor"]);
    expect(Object.getPrototypeOf(value.json())).toBe(Object.prototype);
    expect(value.text()).toBe('{"__proto__":{"polluted":true},"constructor":7}');
    expect(({} as {polluted?:unknown}).polluted).toBeUndefined();
  });
  it("does not implicitly serialize a handle",()=>{
    const value=retain(1);expect(()=>JSON.stringify(value)).toThrow(/explicitly/);
    expect(()=>stringifyJSON(value)).toThrow();expect(isRetainedValue({kind:"number"})).toBe(false);
    const ctor=value.constructor as new (...args:unknown[])=>unknown;
    expect(()=>new ctor({kind:"number",value:2},{})).toThrow(/factory/);
  });
  it("exports arrays and records using retained subtrees",()=>{
    const n=retain(new JSONNumber("1e9999"));const value=recordValue({array:arrayValue([n,null])});
    expect(value.text()).toBe('{"array":[1e9999,null]}');
    expect(()=>arrayValue({} as never)).toThrow();expect(()=>recordValue([] as never)).toThrow();
  });
});

describe("native bytes and lifetime",()=>{
  it("performs no hidden encoding during capture, metadata or native access",()=>{
    const spy=vi.spyOn(globalThis,"btoa").mockImplementation(()=>{throw Error("Unrequested encoding");});
    try {
      const value=recordValue({body:bytesValue(new Uint8Array([1,2,3])),metadata:7});
      const metadata=value.get("metadata")!.scalar(), body=value.get("body")!;
      const native=body.bytes(), length=body.length, byteLength=body.byteLength;
      expect({metadata,native,length,byteLength}).toEqual({metadata:7,native:new Uint8Array([1,2,3]),length:4,byteLength:3});
      expect(spy).not.toHaveBeenCalled();
    } finally {spy.mockRestore();}
  });
  it("reads metadata and forwards bytes without encoding or whole-value JSON",()=>{
    const source=new Uint8Array(1024*1024);source[0]=255;
    const result=recordValue({body:bytesValue(source),metadata:{size:source.length}});
    expect(result.get("metadata")!.get("size")!.scalar()).toBe(source.length);
    const body=result.get("body")!;expect(body.kind).toBe("string");expect(body.length).toBe(1398104);
    expect(body.bytes()).toEqual(source);expect(result.costs.base64Encodes).toBe(0);expect(result.costs.jsonSerializations).toBe(0);
    expect(result.costs.nodesRead).toBeLessThan(15);
  });
  it("snapshots only the supplied byte slice and protects native exports",()=>{
    const source=new Uint8Array([99,1,2,3,99]);const value=bytesValue(source.subarray(1,4));source[2]=8;
    const copy=value.bytes()!;expect([...copy]).toEqual([1,2,3]);copy[0]=9;
    expect(value.scalar()).toBe("AQID");expect(value.text()).toBe('"AQID"');
    expect(value.costs.base64Encodes).toBe(2);expect(value.costs.bytesEncoded).toBe(6);
  });
  it("makes borrowing explicit and snapshots before composition",()=>{
    const source=new Uint8Array([1]);const borrowed=borrowBytes(source),snapshot=borrowed.snapshot(),record=recordValue({body:borrowed});
    expect(borrowed.borrowed).toBe(true);source[0]=2;
    expect(borrowed.scalar()).toBe("Ag==");expect(snapshot.scalar()).toBe("AQ==");expect(record.get("body")!.scalar()).toBe("AQ==");
    expect(record.borrowed).toBe(false);
  });
  it("does not mistake detached borrowed storage for an empty string",()=>{
    const source=new Uint8Array([1]);const borrowed=borrowBytes(source);structuredClone(source.buffer,{transfer:[source.buffer]});
    expect(()=>borrowed.scalar()).toThrow();expect(()=>borrowed.length).toThrow();expect(()=>borrowed.bytes()).toThrow();
  });
  it("keeps child handles alive after parent disposal",()=>{
    const parent=recordValue({body:bytesValue(new Uint8Array([1,2])),metadata:{n:3}}),child=parent.get("body")!;
    parent.dispose();parent.dispose();expect(()=>parent.json()).toThrow(/disposed/);
    expect(child.text()).toBe('"AQI="');child.dispose();expect(()=>child.bytes()).toThrow(/disposed/);
  });
  it("uses the platform Base64 oracle across chunk boundaries",()=>{
    for (const size of [0,1,2,3,12287,12288,12289,24577]) {
      const source=Uint8Array.from({length:size},(_,i)=>(i*131+17)%256);
      expect(bytesValue(source).scalar()).toBe(Buffer.from(source).toString("base64"));
    }
  });
  it("native projection preserves bytes until logical JSON is requested",()=>{
    const value=recordValue({body:bytesValue(new Uint8Array([255])),n:new JSONNumber("9007199254740993")});
    expect((value.native() as {body:unknown}).body).toEqual(new Uint8Array([255]));
    expect(value.costs.base64Encodes).toBe(0);expect(value.text()).toBe('{"body":"/w==","n":9007199254740993}');
  });
  it("does not call subclass byte getters, species or iterators",()=>{
    class HostBytes extends Uint8Array {
      get byteLength():number {throw Error("host getter");}
      [Symbol.iterator]():ArrayIterator<number> {throw Error("host iterator");}
      static get [Symbol.species]():Uint8ArrayConstructor {throw Error("host species");}
    }
    expect(bytesValue(new HostBytes([1,2,3])).scalar()).toBe("AQID");
  });
  it("accepts genuine byte storage from another realm through intrinsics",()=>{
    const bytes=runInNewContext("new Uint8Array([1,2,3])") as Uint8Array;
    expect(bytesValue(bytes).scalar()).toBe("AQID");
    expect(()=>bytesValue(new Uint8ClampedArray([1]) as never)).toThrow(/Uint8Array/);
  });
  it("transfers exclusive buffers while invalidating every source alias",()=>{
    const bytes=new Uint8Array([1,2,3]),alias=new Uint8Array(bytes.buffer);
    const value=transferBytes(bytes);
    expect(bytes.byteLength).toBe(0);expect(alias.byteLength).toBe(0);
    expect(value.costs.bytesCopied).toBe(0);expect(value.byteLength).toBe(3);expect(value.scalar()).toBe("AQID");
  });
  it("refuses partial or over-budget transfers before detaching anything",()=>{
    const bytes=new Uint8Array([1,2,3]);
    expect(()=>transferBytes(bytes.subarray(1))).toThrow(/entire buffer/);expect(bytes.byteLength).toBe(3);
    expect(()=>transferBytes(bytes,{maxBytes:2})).toThrow(/budget/);expect(bytes.byteLength).toBe(3);
  });
  it("records the actual reason for string forcing without exposing mutable counters",()=>{
    const value=bytesValue(new Uint8Array([1,2,3]));
    value.scalar("schema-constraint");value.json("diagnostic");value.text(undefined,"persistence");
    const costs=value.costs;
    expect(costs.stringForcingBytes["schema-constraint"]).toBe(3);expect(costs.stringForcingBytes.diagnostic).toBe(3);expect(costs.stringForcingBytes.persistence).toBe(3);
    expect(costs.stringForcingBytes.export).toBe(0);expect(Object.isFrozen(costs.stringForcingBytes)).toBe(true);
    expect(()=>value.scalar("invented" as never)).toThrow(/forcing reason/);
    expect(value.costs.base64Encodes).toBe(3);
  });
  it("accounts for retained storage without encoding and releases parent reachability",()=>{
    const body=transferBytes(new Uint8Array(1024)),parent=recordValue({body,metadata:{n:3}});
    // Four logical nodes: root object, body string, metadata object, number.
    const before=parent.size();expect(before.nodes).toBe(4);expect(before.nativeBytes).toBe(1024);
    expect(before.scalarBytes).toBe(1052);expect(parent.costs.base64Encodes).toBe(0);
    const child=parent.get("metadata")!;parent.dispose();body.dispose();
    expect(child.size()).toEqual({nodes:2,scalarBytes:4,nativeBytes:0});
    expect(Object.isFrozen(child.size())).toBe(true);
    expect(()=>parent.size()).toThrow(/disposed/);
  });
  it("counts aliased occurrences conservatively and never reuses a detached borrow's size",()=>{
    const child=bytesValue(new Uint8Array(4));expect(arrayValue([child,child]).size()).toEqual({nodes:3,scalarBytes:8,nativeBytes:8});
    const bytes=new Uint8Array(8),borrowed=borrowBytes(bytes);expect(borrowed.size().nativeBytes).toBe(8);
    structuredClone(bytes.buffer,{transfer:[bytes.buffer]});expect(()=>borrowed.size()).toThrow();
  });
});

describe("admission and budgets",()=>{
  it("rejects accessors and hooks without calling them",()=>{
    let calls=0;const getter=Object.defineProperty({},"x",{enumerable:true,get(){calls++;return 1;}});
    expect(()=>retain(getter)).toThrow();expect(()=>retain({toJSON(){calls++;return 1;}})).toThrow();expect(calls).toBe(0);
  });
  it("rejects cycles, holes, executable and undeclared native values",()=>{
    const cycle:unknown[]=[];cycle.push(cycle);
    // eslint-disable-next-line no-sparse-arrays -- A deliberate hole verifies rejection without silent null insertion.
    for (const value of [cycle,[,1],undefined,NaN,Infinity,1n,Symbol(),()=>1,new Date(),new Uint8Array(1),rawJSON("true")]) expect(()=>retain(value)).toThrow();
    expect(retain({rawJSON:"9007199254740993"}).kind).toBe("object");
  });
  it("rejects non-JSON array/object metadata",()=>{
    const array=[1];Object.defineProperty(array,"extra",{value:1});
    const object=Object.defineProperty({},"hidden",{value:1});
    expect(()=>retain(array)).toThrow();expect(()=>retain(object)).toThrow();expect(()=>retain({[Symbol()]:1})).toThrow();
  });
  it("bounds admission, including reused retained handles",()=>{
    expect(()=>retain([1,2],{maxNodes:2})).toThrow(/budget/);
    expect(()=>retain({a:{b:1}},{maxDepth:1})).toThrow(/budget/);
    expect(()=>bytesValue(new Uint8Array(10),{maxBytes:9})).toThrow(/budget/);
    expect(()=>retain("abcd",{maxBytes:7})).toThrow(/budget/);
    expect(()=>retain(1,{maxNodes:0})).toThrow(/positive/);
    expect(()=>retain(retain([1,2]),{maxNodes:2})).toThrow(/budget/);
    expect(()=>recordValue({a:retain({b:1})},{maxDepth:1})).toThrow(/budget/);
    expect(()=>retain(bytesValue(new Uint8Array(10)),{maxBytes:9})).toThrow(/budget/);
  });
  it("refuses shared memory instead of promising an atomic snapshot",()=>{
    expect(()=>bytesValue(new Uint8Array(new SharedArrayBuffer(8)))).toThrow(/Shared/);
  });
});

describe("explicit external access",()=>{
  it("bridges separately owned exact and native values without JSON text",()=>{
    const original=recordValue({n:new JSONNumber("9007199254740993"),body:bytesValue(new Uint8Array([1,2]))});
    const imported=retainFrom(original,retainedValueAccess);
    expect(original.costs.base64Encodes).toBe(0);original.dispose();
    expect(imported.get("n")!.numberToken()).toBe("9007199254740993");expect(imported.get("body")!.bytes()).toEqual(new Uint8Array([1,2]));
  });
  it("checks a trusted adapter's version, domain and structural consistency",()=>{
    const access:ValueAccess<number>={version:1,kind:()=>"array",get:()=>undefined,keys:()=>[],length:()=>1,numberToken:()=>undefined,scalar:()=>undefined};
    expect(()=>retainFrom(1,{...access,version:2} as never)).toThrow(/version/);
    expect(()=>retainFrom(1,access)).toThrow(/Missing array/);
    expect(()=>retainFrom(1,{...access,kind:()=>"number",numberToken:()=>"NaN"})).toThrow();
    expect(()=>retainFrom(1,{...access,kind:()=>"null",scalar:()=>false})).toThrow(/mismatch/);
    expect(()=>retainFrom(1,{...access,kind:()=>"object",keys:()=>["x","x"],get:()=>2,length:()=>0})).toThrow();
    expect(()=>retainFrom(1,{...access,get:()=>1})).toThrow(/Cyclic/);
  });
});

it("matches the established exact JSON codec for a deterministic structural corpus",()=>{
  let seed=0x5eeda11;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
  function value(depth:number):unknown {
    switch(random()%(depth===0?5:7)) {
      case 0:return null;
      case 1:return Boolean(random()%2);
      case 2:return [0,17,-31,0.1,Number.MIN_VALUE][random()%5];
      case 3:return new JSONNumber(["9007199254740993","1e9999","-0.000000000000000000001","-0"][random()%4]!);
      case 4:return ["","😀é","\ud800","\udfff","quote\"slash\\\n"][random()%5];
      case 5:return Array.from({length:random()%5},()=>value(depth-1));
      default:return Object.fromEntries(Array.from({length:random()%5},(_,i)=>[["__proto__","x","0","constructor"][i]!,value(depth-1)]));
    }
  }
  for(let i=0;i<500;i++) {
    const original=value(5), retained=retain(original);
    expect(retained.text()).toBe(stringifyJSON(original));
    expect(stringifyJSON(retained.json())).toBe(stringifyJSON(original));
  }
});

it("exports replaced and computed-stage values while preserving the earlier stage",()=>{
  const before=recordValue({price:new JSONNumber("0.1"),quantity:3,attachment:bytesValue(new Uint8Array([1]))});
  // This package carries assigned computation results; arithmetic belongs to
  // the external evaluator and is independently qualified in its owner.
  const after=recordValue({total:new JSONNumber("0.3"),download:before.get("attachment")});
  expect(after.text()).toBe('{"total":0.3,"download":"AQ=="}');
  expect(before.get("price")!.numberToken()).toBe("0.1");expect(before.get("total")).toBeUndefined();
});
