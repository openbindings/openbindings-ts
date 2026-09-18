import {describe,it,expect} from "vitest";
import {parse,ValueError} from "@openbindings/json";
import {prepareInterface,compareBoundaryContracts} from "./prepared-interface.js";

describe("immutable boundary-pair memo",()=>{
  it("retains exact evidence without confusing mutable inputs or forged owners",async()=>{
    const doc={openbindings:"0.2.0",operations:{x:{input:{const:parse("9007199254740993")}}}};
    const left=(await prepareInterface(doc)).boundaryContract("x");
    const right=(await prepareInterface({...doc,operations:{x:{input:{const:parse("9007199254740993.0")}}}})).boundaryContract("x");
    const a=await left,b=await right;
    for(let i=0;i<1000;i++)expect(compareBoundaryContracts(a!,b!)).toBe("equal");
    doc.operations.x.input.const=parse("9007199254740992");
    const changed=await(await prepareInterface(doc)).boundaryContract("x");
    expect(compareBoundaryContracts(a!,b!)).toBe("equal");
    expect(compareBoundaryContracts(a!,changed!)).toBe("different");
    expect(compareBoundaryContracts(a!,{...b!})).toBe("unavailable");
    const missing=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{$ref:"https://example.invalid/missing"}}}})).boundaryContract("x");
    expect(compareBoundaryContracts(missing!,missing!)).toBe("unavailable");
  });
  it("never turns a capability failure into cached equality",async()=>{
    // Two spellings of the same enormous number cannot be compared within the
    // work limit, so the answer is a refusal every time it is asked, never a
    // remembered "equal". Identical spellings need no such work and are equal.
    const huge=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{const:parse("1e10001")}}}})).boundaryContract("x");
    const spelled=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{const:parse("1.0e10001")}}}})).boundaryContract("x");
    for(let i=0;i<2;i++){
      let raised:unknown;
      try{compareBoundaryContracts(huge!,spelled!);}catch(error){raised=error;}
      expect(raised).toBeInstanceOf(ValueError);
      expect((raised as ValueError).code).toBe("ERR_JSON_BUDGET");
    }
    const same=await(await prepareInterface({openbindings:"0.2.0",operations:{x:{input:{const:parse("1e10001")}}}})).boundaryContract("x");
    expect(compareBoundaryContracts(huge!,same!)).toBe("equal");
  });
});
