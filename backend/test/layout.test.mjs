import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { cleanSettings, groupsFor } from "../src/layout.mjs";
const html=fs.readFileSync(new URL("../../index.html",import.meta.url),"utf8");
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test("single HTML syntax remains valid",()=>{new vm.Script(script);});
test("backend groups match the existing classroom layout across number, fruit and capacity limits",()=>{
  const constants=script.slice(script.indexOf("  var DEFAULT_SETTINGS ="),script.indexOf("  var SETTINGS_KEY ="));
  const normal=script.slice(script.indexOf("  function normalizeSettings("),script.indexOf("  function firebaseConfigIsReady("));
  const layout=script.slice(script.indexOf("  function createNumberGroups("),script.indexOf("  function displayColumnLabel("));
  const context={};vm.createContext(context);
  vm.runInContext('function todayKey(){return "2026-10-07";}function firebaseIsConfigured(){return true;}'+constants+normal+layout,context);
  for (const mode of ["number","plainNumber","fruit"]) for (const totalStudents of [1,7,18,80,105,181,183,600]) for (const remainderMode of ["singleExtra","balanced"]) for (const columnFillMode of ["fill","even"]) for (const rowLimitPerColumn of [0,5,10]) {
    const s={mode,totalStudents,remainderMode,columnFillMode,rowLimitPerColumn,columnCount:5,groupSize:4,columnRowLimits:rowLimitPerColumn===5?"5,5,5,6,6":""};
    const expected=context[mode==="fruit"?"createFruitGroups":"createNumberGroups"](context.normalizeSettings(s));
    assert.deepEqual(groupsFor(cleanSettings(s)),JSON.parse(JSON.stringify(expected)));
  }
});
