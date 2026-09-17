import { describe, expect, it, vi } from "vitest";
import { JSONNumber, parseJSON, stringifyJSON } from "@openbindings/json";
import { bytesValue, borrowBytes, recordValue, retain } from "@openbindings/json/values";
import { compileSchema, compileValueSchema, EXACT_DRAFT_2020, RETAINED_DRAFT_2020, valueInstance } from "./index.js";

describe("retained schema instances", () => {
  it("does not demand numeric comparison for different logical types in uniqueItems", () => {
    const value=retain([new JSONNumber("1e10001"),"different type"]);
    expect(compileValueSchema({uniqueItems:true}).validate(value).valid).toBe(true);
    expect(compileSchema({uniqueItems:true},{drafts:[EXACT_DRAFT_2020]}).validate(value.json()).valid).toBe(true);
    value.dispose();
  });
  it("validates reference, type and length metadata without encoding", () => {
    const schema = { $defs:{binary:{type:"string",minLength:4,maxLength:4}},
      allOf:[{properties:{body:{$ref:"#/$defs/binary"},id:{const:parseJSON("9007199254740993")}}}],
      required:["body","id"],unevaluatedProperties:false };
    const value = recordValue({body:bytesValue(new Uint8Array([1,2,3])),id:parseJSON("9007199254740993")});
    const btoa = vi.spyOn(globalThis,"btoa").mockImplementation(() => {throw Error("Unexpected encoding");});
    try { expect(compileValueSchema(schema).validate(value).valid).toBe(true); }
    finally { btoa.mockRestore(); }
  });

  it("forces pattern characters but retains the binary source", () => {
    const value=bytesValue(new Uint8Array([1,2,3]));
    const result=compileValueSchema({type:"string",pattern:"^AQID$"}).validate(value);
    expect(result.valid).toBe(true);
    expect(result.costs.stringForcingBytes["schema-constraint"]).toBe(3);
    expect(value.bytes()).toEqual(new Uint8Array([1,2,3]));
  });

  const schemas = [
    true,false,{}, {type:"string"},{type:"object"},{type:["object","string"]},
    {type:"string",minLength:5},{type:"string",maxLength:3},
    {minProperties:1},{maxProperties:0},{required:["x"]},{properties:{x:false}},
    {additionalProperties:false},{patternProperties:{".*":false}},{propertyNames:false},
    {dependentRequired:{x:["y"]}},{dependentSchemas:{x:false}},{unevaluatedProperties:false},
    {const:"AQID"},{const:"AQIE"},{enum:["AQID",null]},{enum:[null,0]},
    {pattern:"^AQ"},{pattern:"^XYZ"},{oneOf:[{type:"string"},{type:"object"}]},
    {oneOf:[{type:"string"},{minLength:4}]},{oneOf:[{type:"number"},{type:"object"}]},
    {anyOf:[{type:"number"},{type:"string"}]},{anyOf:[{type:"number"},{type:"null"}]},
    {not:{type:"object"}},{not:{type:"string"}},
    {if:{type:"string"},then:{maxLength:4},else:false},
    {allOf:[{type:"string"},{minLength:4}],format:"uri",contentEncoding:"base64"},
    {$defs:{v:{type:"string"}},$ref:"#/$defs/v"},
  ];
  for (const schema of schemas) {
    it(`matches the existing validator on a byte-backed scalar: ${JSON.stringify(schema)}`, () => {
      const expected=compileSchema(schema,{drafts:[EXACT_DRAFT_2020]}).validate("AQID");
      const actual=compileValueSchema(schema).validate(bytesValue(new Uint8Array([1,2,3])));
      expect(actual.valid).toBe(expected.valid);
      expect(actual.errors.map(e=>[e.code,e.message,e.data.pointer])).toEqual(expected.errors.map(e=>[e.code,e.message,e.data.pointer]));
    });
  }

  for (const [schema, input] of [
    [{uniqueItems:true},[new Uint8Array([1,2,3]),new Uint8Array([1,2,3])]],
    [{uniqueItems:true},[new Uint8Array([1,2,3]),new Uint8Array([1,2,4])]],
    [{prefixItems:[{type:"string"}],contains:{const:"AQID"},minContains:1,maxContains:1,unevaluatedItems:false},[new Uint8Array([1,2,3])]],
    [{oneOf:[{properties:{body:{const:"x"}},required:["body"]},{type:"array"}]},{body:new Uint8Array([1,2,3])}],
    [{const:{body:"AQID"}},{body:new Uint8Array([1,2,3])}],
    [{allOf:[{properties:{body:{type:"string"}}}],unevaluatedProperties:false},{body:new Uint8Array([1,2,3]),extra:true}],
  ] as const) {
    it(`keeps nested annotations/equality/diagnostics: ${JSON.stringify(schema)}`, () => {
      const retained = retain("body" in input ? recordValue({ ...input, body:bytesValue(input.body) }) : input.map(v=>bytesValue(v)));
      const expected=compileSchema(schema,{drafts:[EXACT_DRAFT_2020]}).validate(retained.json());
      const actual=compileValueSchema(schema).validate(retained);
      expect(actual.valid).toBe(expected.valid);
      expect(actual.errors.map(e=>[e.code,e.message,e.data.pointer])).toEqual(expected.errors.map(e=>[e.code,e.message,e.data.pointer]));
    });
  }

  it("keeps ordinary marker objects and exact numeric schema semantics", () => {
    const value=retain(parseJSON('{"rawJSON":"7","isLosslessNumber":true,"n":9007199254740993}'));
    expect(compileValueSchema({properties:{rawJSON:{type:"string"},isLosslessNumber:{type:"boolean"},n:{const:parseJSON("9007199254740993")}}}).validate(value).valid).toBe(true);
    expect(compileValueSchema({properties:{n:{maximum:parseJSON("9007199254740992")}}}).validate(value).valid).toBe(false);
    expect(()=>valueInstance({} as never)).toThrow(/authenticated retained value/);
  });

  it("snapshots borrowed storage and child views survive source disposal", () => {
    const bytes=new Uint8Array([1,2,3]), source=borrowBytes(bytes);
    const instance=valueInstance(source);
    bytes.fill(0);source.dispose();
    const schema=compileSchema({const:"AQID"},{drafts:[RETAINED_DRAFT_2020]});
    expect(schema.validate(instance).valid).toBe(true);
    expect(JSON.stringify(instance)).toBe('"AQID"');
    const parent=recordValue({body:bytesValue(new Uint8Array([1,2,3]))});
    const childInstance=valueInstance(parent);
    parent.dispose();
    expect(compileSchema({properties:{body:{const:"AQID"}}},{drafts:[RETAINED_DRAFT_2020]}).validate(childInstance).valid).toBe(true);
    const owned=bytesValue(new Uint8Array([1,2,3])), ownedInstance=valueInstance(owned);
    owned.dispose();
    expect(JSON.stringify(ownedInstance)).toBe('"AQID"');
  });

  it("accepts an explicit foreign value access capability", () => {
    const value=new Uint8Array([1,2,3]);
    const access={version:1 as const,kind:()=>"string" as const,get:()=>undefined,keys:()=>[],length:()=>4,
      numberToken:()=>undefined,scalar:()=>{throw Error("Unexpected characters");},byteLength:()=>3,bytes:()=>value};
    const validator=compileValueSchema({type:"string",minLength:4,maxLength:4});
    expect(validator.validate(value,access).valid).toBe(true);
    const instance=valueInstance(value,access);
    value.fill(0);
    expect(JSON.stringify(instance)).toBe('"AQID"');
  });

  it("does not stringify an instance merely to prepare its validation view", () => {
    const value=recordValue({id:parseJSON("1e400"),body:bytesValue(new Uint8Array(1024*1024))});
    const btoa=vi.spyOn(globalThis,"btoa").mockImplementation(()=>{throw Error("Unexpected Base64");});
    try {
      const node=compileSchema({properties:{body:{type:"string",minLength:1},id:{type:"number"}},required:["body"]},{drafts:[RETAINED_DRAFT_2020]});
      expect(node.validate(valueInstance(value)).valid).toBe(true);
    } finally { btoa.mockRestore(); }
  });

  it("produces the same decisions for a deterministic ordinary JSON corpus", () => {
    const schema={type:"object",properties:{n:{type:"number",multipleOf:0.1},a:{type:"array",items:{type:["null","string","integer"]},uniqueItems:true}},required:["n"],additionalProperties:false};
    const ordinary=compileSchema(schema,{drafts:[EXACT_DRAFT_2020]}), retained=compileValueSchema(schema);
    for(let i=0;i<500;i++) {
      const value={n:parseJSON(`${i%3===0?"9007199254740993":String(i)}.${i%10}`),a:i%2?[null,"é",i]:[i,i]};
      expect(retained.validate(retain(value)).valid,stringifyJSON(value)).toBe(ordinary.validate(value).valid);
    }
  });
});
