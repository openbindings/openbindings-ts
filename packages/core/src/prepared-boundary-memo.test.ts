import {describe,it,expect} from "vitest";
import {parseJSON,JSONCapabilityError} from "@openbindings/json";
import {prepareInterface,compareBoundaryContracts} from "./prepared-interface.js";

describe("immutable boundary-pair memo",()=>{
  it("retains exact evidence without confusing mutable inputs or forged owners",async()=>{
    const doc={openbindings:"0.2.0",operations:{x:{input:{const:parseJSON("9007199254740993")}}}};
    const left=(await prepareInterface(doc)).boundaryContract("x");
    const right=(await prepareInterface({...doc,operations:{x:{input:{const:parseJSON("9007199254740993.0")}}}})).boundaryContract("x");
    const a=await left,b=await right;
    for(let i=0;i<1000;i++)expect(compareBoundaryContracts(a!,b!)).toBe("equal");
    doc.operations.x.input.const=parseJSON("9007199254740992");
    const changed=await(await prepareInterface(doc)).boundaryContract("x");
    expect(compareBoundaryContracts(a!,b!)).toBe("equal");
    expect(compareBoundaryContracts(a!,changed!)).toBe("different");
    expect(compareBoundaryContracts(a!,{...b!})).toBe("unavailable");
    const missing=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{$ref:"https://example.invalid/missing"}}}})).boundaryContract("x");
    expect(compareBoundaryContracts(missing!,missing!)).toBe("unavailable");
  });
  it("never turns a capability failure into cached equality",async()=>{
    const huge=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{const:parseJSON("1e10001")}}}})).boundaryContract("x");
    const other=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{const:parseJSON("1e10001")}}}})).boundaryContract("x");
    for(let i=0;i<2;i++)expect(()=>compareBoundaryContracts(huge!,other!)).toThrow(JSONCapabilityError);
  });
});
