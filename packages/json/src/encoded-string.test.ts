import {describe,it,expect,vi} from "vitest";
import {base64,encodedString,retain,retainFrom,retainedValueAccess,type StringEncoding,type ValueAccess,type RetainedValue} from "./values.js";
const hex: StringEncoding={length:bytes=>bytes.length*2,encode:bytes=>Buffer.from(bytes).toString("hex")};

describe("owned deferred logical strings",()=>{
  it("offers explicit native, JSON and text views without eager encoding",()=>{
    const encode=vi.fn(hex.encode), source=new Uint8Array([251,255]);
    const value=encodedString(source,{...hex,encode}); source[0]=0;
    expect(value.kind).toBe("string");expect(value.length).toBe(4);
    expect(value.byteLength).toBeUndefined();expect(value.bytes()).toBeUndefined();
    const native=value.native() as Uint8Array;expect([...native]).toEqual([251,255]);native[0]=0;
    expect(encode).not.toHaveBeenCalled();expect(value.json()).toBe("fbff");expect(value.text()).toBe('"fbff"');
    expect(base64(new Uint8Array([251,255])).json()).toBe("+/8=");
    expect(value.costs.base64Encodes).toBe(0);
  });
  it("copies across the optional bridge and survives disposal of ancestors",()=>{
    const encode=vi.fn(hex.encode), leaf=encodedString(new Uint8Array([251,255]),{...hex,encode});
    const parent=retain({data:leaf}), child=parent.get("data")!;
    const captured=retainFrom(child,retainedValueAccess);parent.dispose();child.dispose();leaf.dispose();
    expect(encode).not.toHaveBeenCalled();expect(captured.native()).toEqual(new Uint8Array([251,255]));
    expect(captured.text()).toBe('"fbff"');captured.dispose();expect(()=>captured.native()).toThrow(/disposed/);
  });
  it("uses correct logical fallback when the consumer lacks the extension",()=>{
    const value=encodedString(new Uint8Array([251,255]),hex);
    const legacy={...retainedValueAccess};delete legacy.deferredString;
    const result=retainFrom(value,legacy);expect(result.native()).toBe("fbff");expect(result.json()).toBe("fbff");
  });
  it("protects backing from adapter callbacks, native exports and adapter mutation",()=>{
    const adapter={length:(b:Uint8Array)=>{b[0]=0;return b.length*2;},encode:(b:Uint8Array)=>{const text=hex.encode(b);b.fill(0);return text;}};
    const value=encodedString(new Uint8Array([251,255]),adapter);adapter.encode=()=>"0000";
    expect(value.json()).toBe("fbff");expect(value.native()).toEqual(new Uint8Array([251,255]));
  });
  it("budgets the declared expansion before bridge allocation and propagates encoder failures",()=>{
    const encode=vi.fn(hex.encode),value=encodedString(new Uint8Array([251,255]),{...hex,encode},{maxBytes:18});
    expect(value.size()).toEqual({nodes:1,scalarBytes:18,nativeBytes:2});
    expect(()=>retain(value,{maxBytes:17})).toThrow(/budget/);
    expect(()=>retainFrom(value,retainedValueAccess,{maxBytes:17})).toThrow(/budget/);
    expect(()=>encodedString(new Uint8Array([1]),hex,{maxBytes:8})).toThrow(/budget/);
    expect(encode).not.toHaveBeenCalled();
    for(const length of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER]) expect(()=>encodedString(new Uint8Array(),{length:()=>length,encode:()=>""})).toThrow();
    const failure=Error("encoder failed");expect(()=>encodedString(new Uint8Array(),{length:()=>0,encode:()=>{throw failure;}}).text()).toThrow(failure);
    expect(()=>encodedString(new Uint8Array(),{length:()=>1,encode:()=>"wrong"}).json()).toThrow(/length/);
  });
  it("counts Unicode code points and includes an empty logical value with nonempty backing",()=>{
    for(const text of ["", "😀", "é", "\ud800", '"\n']) {
      const value=encodedString(new Uint8Array([1]),{length:()=>[...text].length,encode:()=>text});
      expect(value.length).toBe([...text].length);expect(value.json()).toBe(text);expect(JSON.parse(value.text())).toBe(text);
    }
  });
  it("rejects inconsistent bridge metadata and never negotiates an inherited getter",()=>{
    const value=encodedString(new Uint8Array([1]),hex),storage=retainedValueAccess.deferredString!(value)!;
    for(const patch of [{length:3},{byteLength:-1},{encode:null},{copyBytesInto:()=>0}]) {
      const access={...retainedValueAccess,deferredString:()=>({...storage,...patch})} as ValueAccess<RetainedValue>;
      expect(()=>retainFrom(value,access)).toThrow();
    }
    const legacy={...retainedValueAccess};delete legacy.deferredString;
    Object.setPrototypeOf(legacy,{get deferredString(){throw Error("must not read");}});
    expect(retainFrom(value,legacy).json()).toBe("01");
  });
});
