import test from "node:test";
import assert from "node:assert/strict";
import { FirebaseStore } from "../src/firebase.mjs";
import { makeWorker } from "../src/worker.mjs";
import { cleanSettings } from "../src/layout.mjs";
const host=process.env.FIREBASE_DATABASE_EMULATOR_HOST;
test("Firebase emulator refuses every direct write, including signed-in clients, and hides ownership", {skip:!host}, async()=>{
  assert.match(host,/^(?:127\.0\.0\.1|localhost):\d+$/);
  const base="http://"+host;
  async function request(path,method="GET",body,privileged=false) {
    return fetch(base+"/"+path+".json?ns=demo-class-picker-default-rtdb",{method,headers:{"content-type":"application/json",...(privileged?{authorization:"Bearer owner"}:{})},body:method==="GET"?undefined:JSON.stringify(body)});
  }
  const data={control:{teachers:{private:{disabled:false}}},rooms:{1037:{ownerId:"private",settings:{sessionId:"keep",totalStudents:8},groupCounts:{A1:1},groupStats:{A1:{total:1,male:1,female:0}},assignments:{known:{sessionId:"keep",result:{id:"A1"}}}}}};
  assert.equal((await request("","PUT",data,true)).status,200);
  for (const path of ["rooms/1037/settings","rooms/1037/groupCounts","rooms/1037/groupStats","rooms/1037/assignments/known"]) assert.equal((await request(path)).status,200);
  for (const path of ["","rooms","rooms/1037","rooms/1037/ownerId","rooms/1037/assignments","control/teachers/private"]) assert.equal((await request(path)).status,401);
  for (const [path,value] of [["rooms/1037/settings",{totalStudents:600}], ["rooms/1037/groupCounts/A1",999], ["rooms/1037/assignments/known",null], ["rooms/1037",null], ["rooms/1037/ownerId","attacker"], ["rooms/7015",{settings:{totalStudents:8}}], ["control/teachers/private",{disabled:false}]]) {
    assert.equal((await request(path,"PUT",value)).status,401);
  }
  assert.equal((await request("rooms/1037","PATCH",{assignments:null,groupCounts:null})).status,401);
  assert.deepEqual(await (await request("","GET",null,true)).json(),data);
  // A Firebase Auth identity gets no write grant either. Emulator mock auth token.
  const encode=v=>Buffer.from(JSON.stringify(v)).toString("base64url");
  const token=encode({alg:"none",typ:"JWT"})+"."+encode({iss:"https://securetoken.google.com/demo-class-picker",aud:"demo-class-picker",sub:"student",user_id:"student",iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,auth_time:Math.floor(Date.now()/1000),firebase:{sign_in_provider:"anonymous",identities:{}}})+".";
  const signed=await fetch(base+"/rooms/1037/settings.json?ns=demo-class-picker-default-rtdb&auth="+token,{method:"PUT",body:JSON.stringify({totalStudents:600})});
  assert.equal(signed.status,401);
});

test("100 concurrent draws through the real Firebase REST compare-and-swap keep the 80-seat limit", {skip:!host}, async()=>{
  const origin="https://app.example",settings=cleanSettings({totalStudents:80,groupSize:4,columnCount:4,sessionId:"load-session"});
  const store=new FirebaseStore({FIREBASE_DATABASE_URL:"https://test.firebaseio.com"},async(url,options)=>fetch("http://"+host+new URL(url).pathname+"?ns=demo-class-picker-default-rtdb",options));
  store.token=async()=>"owner";
  await store.update("rooms/load-test",()=>({ownerId:"trusted-fixture",settings}));
  const env={ALLOWED_ORIGIN:origin,ADMIN_SIGNING_KEY:"fixture-signing-key-".repeat(4),OP_LIMIT:{limit:async()=>({success:true})}};
  const worker=makeWorker(()=>store),started=Date.now();
  const responses=await Promise.all(Array.from({length:100},(_,i)=>worker.fetch(new Request("https://api.example/api/draw",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({roomId:"load-test",deviceId:"test-"+i,sessionId:settings.sessionId,gender:""})}),env)));
  assert.ok(responses.every(r=>r.status===200));
  const values=await Promise.all(responses.map(r=>r.json()));assert.equal(values.filter(r=>r.result).length,80);
  const room=await store.get("rooms/load-test");assert.equal(Object.keys(room.assignments).length,80);assert.equal(Object.values(room.groupCounts).reduce((sum,n)=>sum+n,0),80);assert.ok(Object.values(room.groupCounts).every(n=>n===4));
  console.log("Emulator concurrency: 100 requests / 80 assignments in "+(Date.now()-started)+" ms; no lost counts. This does not measure Cloudflare CPU or production latency.");
});
