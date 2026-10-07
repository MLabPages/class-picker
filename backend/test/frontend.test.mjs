import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { makeWorker } from "../src/worker.mjs";
import { cleanSettings } from "../src/layout.mjs";
const html=fs.readFileSync(new URL("../../index.html",import.meta.url),"utf8");

function storage(initial={}) {
  const values=new Map(Object.entries(initial));
  return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
}
function element() {
  const classes=new Set();
  return {value:"",checked:false,disabled:false,textContent:"",innerHTML:"",classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>{if(on===undefined)on=!classes.has(c);on?classes.add(c):classes.delete(c);}},addEventListener(){},scrollIntoView(){}};
}
class Store {
  constructor(){this.data={rooms:{},control:{teachers:{}}};}
  async get(p){let v=this.data;for(const k of p.split("/"))v=v?.[k];return structuredClone(v??null);}
  async update(p,fn){const keys=p.split("/"),last=keys.pop();let v=this.data;for(const k of keys)v=v[k]||={};const next=fn(structuredClone(v[last]??null));if(next!==undefined)v[last]=structuredClone(next);return structuredClone(v[last]??null);}
}
function app(store,{local=false,partial=false}={}) {
  const elements={},alerts=[],requests=[],localStorage=storage({group_picker_device_id_v1:"qa-device"}),sessionStorage=storage();
  let failing=false;
  const worker=makeWorker(()=>({get:p=>store.get(p),update:async(p,fn)=>{if(failing)throw new Error("fixture-only");return store.update(p,fn);}}));
  const env={ALLOWED_ORIGIN:"https://app.example",ADMIN_SIGNING_KEY:"fixture-signing-secret".repeat(4),REGISTRATION_ENABLED:"true",AUTH_LIMIT:{limit:async()=>({success:true})},OP_LIMIT:{limit:async()=>({success:true})},DAILY_LIMIT:{limit:async()=>({success:true})}};
  const fetcher=async(url,options)=>{
    requests.push(new URL(url).pathname);
    return worker.fetch(new Request(url,{...options,headers:{...options.headers,origin:env.ALLOWED_ORIGIN}}),env);
  };
  const context={window:{location:{href:"https://app.example/?room=1037",search:"?room=1037",hostname:"app.example"},crypto,TextEncoder},document:{getElementById:id=>elements[id]||=(element())},localStorage,sessionStorage,console:{warn(){},error(){}},navigator:{clipboard:{writeText:async()=>{}}},crypto,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,Date,Uint8Array,Uint32Array,fetch:fetcher,setTimeout,clearTimeout,setInterval:()=>1,clearInterval:()=>{},alert:m=>alerts.push(m),confirm:()=>true};
  context.window.prompt=()=>{};
  let source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('var API_BASE = "";','var API_BASE = "https://api.example";');
  if(local||partial)source=source.replace(/var FIREBASE_CONFIG = \{[\s\S]*?\n  \};/,partial?'var FIREBASE_CONFIG = {databaseURL:"partial-test"};':'var FIREBASE_CONFIG = {};');
  source=source.replace('  init();',`  globalThis.qa={ init, draw, renderAll, restoreState, loadSettingsFromFirebase, switchRoom, copyRoomShareUrl, saveSettingsFromAdmin, resetThisDeviceFromAdmin, resetAllFromAdmin, runAdminAction, getFirebaseAssignment, get settings(){return appState.settings;}, get session(){return teacherSession;}, configure(f){appState.firebaseFns=f;appState.firebaseReady=true;appState.db={};} };`);
  vm.createContext(context);vm.runInContext(source,context);
  const fns={ref:(db,path)=>({path}),get:async ref=>{const value=await store.get(ref.path);return {exists:()=>value!==null,val:()=>value};}};
  return {ctx:context,qa:context.qa,elements,localStorage,alerts,requests,fns,fail:value=>{failing=value;},call:async(p,b,t)=>{const r=await fetcher("https://api.example"+p,{method:"POST",headers:{"Content-Type":"application/json",...(t?{Authorization:"Bearer "+t}:{})},body:JSON.stringify(b)});return r.json();}};
}
async function prepared() {
  const store=new Store(),a=app(store),teacher=await a.call("/api/teachers",{});
  const s=cleanSettings({mode:"plainNumber",totalStudents:8,groupSize:4,columnCount:2,rowLimitPerColumn:10});delete s.sessionId;delete s.lastResetDate;
  for(const roomId of ["1037","7015"])await a.call("/api/rooms/create",{roomId,settings:s},teacher.token);
  a.qa.configure(a.fns);await a.qa.loadSettingsFromFirebase();a.qa.renderAll();await a.qa.restoreState();
  return {...a,store,teacher};
}
test("front end keeps result and settings after a wrong code or server failure",async()=>{
  const a=await prepared();await a.qa.draw();
  const localResult=a.localStorage.getItem("group_picker_result_v1"),remote=await a.store.get("rooms/1037"),settings=JSON.stringify(a.qa.settings);
  a.elements.adminCode.value="wrong";a.elements.totalStudentsInput.value="12";
  await a.qa.runAdminAction(a.qa.saveSettingsFromAdmin);
  assert.match(a.alerts.at(-1),/管理コードが違う/);assert.equal(a.localStorage.getItem("group_picker_result_v1"),localResult);assert.equal(JSON.stringify(a.qa.settings),settings);assert.deepEqual(await a.store.get("rooms/1037"),remote);
  a.elements.adminCode.value=a.teacher.code;await a.qa.copyRoomShareUrl();a.fail(true);
  await a.qa.runAdminAction(a.qa.saveSettingsFromAdmin);
  assert.equal(a.localStorage.getItem("group_picker_result_v1"),localResult);assert.equal(JSON.stringify(a.qa.settings),settings);assert.deepEqual(await a.store.get("rooms/1037"),remote);
  assert.equal(a.elements.saveSettingsButton.disabled,false);
});
test("front end reuses one teacher session across 1037 and 7015 and preserves other-room results",async()=>{
  const a=await prepared();await a.qa.draw();const original=await a.store.get("rooms/1037");
  a.elements.adminCode.value=a.teacher.code;await a.qa.copyRoomShareUrl();assert.ok(a.qa.session);assert.equal(a.elements.adminCode.value,"");
  const logins=a.requests.filter(p=>p==="/api/session").length;
  await a.qa.switchRoom("7015");await a.qa.draw();await a.qa.runAdminAction(a.qa.resetThisDeviceFromAdmin);
  assert.equal(a.requests.filter(p=>p==="/api/session").length,logins);
  assert.deepEqual(await a.store.get("rooms/1037"),original);
  assert.equal((await a.store.get("rooms/7015")).assignments["qa-device"],undefined);
});
test("server-unavailable draw fails closed and reconnect restores the already saved assignment",async()=>{
  const a=await prepared();await a.qa.draw();const result=a.localStorage.getItem("group_picker_result_v1");
  await a.qa.switchRoom("7015");a.localStorage.setItem("group_picker_result_v1",result);a.fail(true);await a.qa.draw();
  assert.equal(a.elements.drawButton.disabled,true);assert.equal(a.elements.resultName.textContent,"抽選を停止しています");assert.equal(a.localStorage.getItem("group_picker_result_v1"),result);
  a.fail(false);a.qa.configure(a.fns);await a.qa.switchRoom("1037");
  assert.equal(a.elements.drawButton.textContent,"抽選済み");assert.equal(a.localStorage.getItem("group_picker_result_v1"),result);
  assert.equal(Object.keys((await a.store.get("rooms/1037")).assignments).length,1);
});
test("local mode still draws and resets without API calls; partial config never falls back",async()=>{
  const local=app(new Store(),{local:true});await local.qa.init();await local.qa.draw();assert.ok(local.localStorage.getItem("group_picker_result_v1"));
  local.elements.adminCode.value="reset2026";await local.qa.resetThisDeviceFromAdmin();assert.equal(local.localStorage.getItem("group_picker_result_v1"),null);assert.equal(local.requests.length,0);
  const partial=app(new Store(),{partial:true});partial.localStorage.setItem("group_picker_result_v1","preserved");await partial.qa.init();await partial.qa.draw();
  assert.equal(partial.elements.drawButton.disabled,true);assert.equal(partial.localStorage.getItem("group_picker_result_v1"),"preserved");assert.equal(partial.requests.length,0);
});
test("a delayed result from the previous room cannot overwrite the next room",async()=>{
  const a=await prepared();await a.qa.draw();await a.qa.switchRoom("7015");await a.qa.draw();await a.qa.switchRoom("1037");
  let complete;const originalGet=a.fns.get;
  a.fns.get=ref=>ref.path==="rooms/1037/assignments/qa-device"?new Promise(resolve=>{complete=resolve;}):originalGet(ref);
  const delayed=a.qa.restoreState();await a.qa.switchRoom("7015");const newer=a.localStorage.getItem("group_picker_result_v1");
  complete(await originalGet({path:"rooms/1037/assignments/qa-device"}));await delayed;
  assert.equal(a.localStorage.getItem("group_picker_result_v1"),newer);
});
