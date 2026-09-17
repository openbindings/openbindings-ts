import {expect,it} from "vitest";
import {encodedString} from "@openbindings/json/values";
import {compileValueSchema} from "./index.js";
it("validates third-party strings using their logical content",()=>{
 const value=encodedString(new Uint8Array([251,255]),{length:b=>b.length*2,encode:b=>Buffer.from(b).toString("hex")});
 expect(compileValueSchema({type:"string",pattern:"^fbff$",minLength:4,maxLength:4}).validate(value).valid).toBe(true);
 expect(compileValueSchema({const:"+/8="}).validate(value).valid).toBe(false);
 value.dispose();
});
