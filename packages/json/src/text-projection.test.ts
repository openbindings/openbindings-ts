import {describe,it,expect} from "vitest";
import {JSONNumber,numberToken,stringifyJSON} from "./index.js";
import {retain,bytesValue,borrowBytes} from "./values.js";

describe("direct retained text projection",()=>{
  for(const space of [undefined,0,2,"\t",12])it(`preserves exact leaves and standard whitespace for ${String(space)}`,()=>{
    const value=retain({id:new JSONNumber("9007199254740993"),price:new JSONNumber("0.1000"),text:"\ud800x",nested:[{},[],null,false,-0],body:bytesValue(new Uint8Array([1,2,3]))});
    const expected=stringifyJSON(value.json(),space);
    expect(value.text(space)).toBe(expected);expect(value.text()).toContain('"id":9007199254740993');
    expect(value.text()).toContain('"price":0.1000');expect(value.text()).toContain('"text":"\\ud800x"');
    const view=value.json() as Record<string,unknown>;
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);expect(Object.getPrototypeOf(view.nested)).toBe(Array.prototype);
    expect(numberToken(view.id)).toBe("9007199254740993");expect(value.get("body")!.bytes()).toEqual(new Uint8Array([1,2,3]));
  });
  it("never invokes inherited serializer hooks and preserves own special keys",()=>{
    const source=JSON.parse('{"__proto__":{"x":1},"constructor":2,"toJSON":"data","items":[{"x":3}]}') as unknown;
    const value=retain(source);let text;
    const hook={configurable:true,get(){throw Error("inherited serialization hook");}};
    Object.defineProperty(Object.prototype,"toJSON",hook);Object.defineProperty(Array.prototype,"toJSON",hook);
    try {text=value.text();}
    finally {Reflect.deleteProperty(Object.prototype,"toJSON");Reflect.deleteProperty(Array.prototype,"toJSON");}
    expect(text).toBe('{"__proto__":{"x":1},"constructor":2,"toJSON":"data","items":[{"x":3}]}');
    expect(Object.getPrototypeOf(value.json())).toBe(Object.prototype);
  });
  it("keeps caller objects on checked serialization and refuses invalid admission",()=>{
    for(const bad of [{toJSON(){return 1;}},{get value(){throw Error("getter");}},[undefined],[,]]) {
      expect(()=>stringifyJSON(bad)).toThrow();expect(()=>retain(bad)).toThrow();
    }
    const cycle: unknown[]=[];cycle.push(cycle);expect(()=>retain(cycle)).toThrow();
  });
  it("projects borrowed bytes only on request and observes later mutations",()=>{
    const source=new Uint8Array([1,2,3]),value=borrowBytes(source);
    expect(value.costs.base64Encodes).toBe(0);expect(value.text()).toBe('"AQID"');source[0]=4;
    expect(value.text()).toBe('"BAID"');expect(value.costs.base64Encodes).toBe(2);
    value.dispose();expect(()=>value.text()).toThrow(/disposed/);
  });
});
