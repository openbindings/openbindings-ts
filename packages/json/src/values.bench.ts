import { afterAll, bench, describe } from "vitest";
import { JSONNumber } from "./index.js";
import { bytesValue, retain } from "./values.js";

// Routine wall-time observations. Project owns separate performance acceptance.
const options={time:100,iterations:10,warmupTime:50,warmupIterations:5};
const small=retain({id:new JSONNumber("9007199254740993"),ok:true,label:"sample"});
const large=retain({id:new JSONNumber("9007199254740993"),price:new JSONNumber("0.1"),text:"\ud800x",
  data:bytesValue(new Uint8Array(4096)),items:Array.from({length:1000},(_,i)=>new JSONNumber(String(i)))});
let consumed: unknown;
describe("retained projections after admission",()=>{
  bench("small JSON view",()=>{consumed=small.json();},options);
  bench("small JSON text",()=>{consumed=small.text();},options);
  bench("retained-text JSON view",()=>{consumed=large.json();},options);
  bench("retained-text JSON text",()=>{consumed=large.text();},options);
  bench("native bytes from selected child",()=>{consumed=large.get("data")!.bytes();},options);
});
afterAll(()=>{if(consumed===undefined)throw Error("Benchmark output was not consumed");small.dispose();large.dispose();});
