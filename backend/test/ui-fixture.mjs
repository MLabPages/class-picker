// Browser QA server. Binds loopback only and uses disposable in-memory data.
// It never authenticates against or contacts a real Firebase database.
import http from "node:http";
import fs from "node:fs";
import { makeWorker } from "../src/worker.mjs";
import { teacherId } from "../src/crypto.mjs";
import { cleanSettings } from "../src/layout.mjs";

const code="CP-"+"Q".repeat(32), id=await teacherId(code);
const settings=cleanSettings({mode:"plainNumber",totalStudents:8,groupSize:4,columnCount:2,sessionId:"qa-session",autoDailyReset:false});
const store={
  data:{control:{teachers:{[id]:{disabled:false,createdAt:1}}},rooms:{1037:{ownerId:id,settings:structuredClone(settings)},7015:{ownerId:id,settings:{...settings,sessionId:"qa-session-7015"}}}},
  async get(path) { let v=this.data;for(const p of path.split("/"))v=v?.[p];return structuredClone(v??null); },
  pending:Promise.resolve(),
  async update(path,fn) { const work=this.pending.then(async()=>{const parts=path.split("/"),key=parts.pop();let p=this.data;for(const part of parts)p=p[part]||={};const next=fn(structuredClone(p[key]??null));if(next!==undefined)p[key]=structuredClone(next);return structuredClone(p[key]??null);});this.pending=work.catch(()=>{});return work; }
};
let failing=false;
const worker=makeWorker(()=>({get:async path=>store.get(path),update:async(path,fn)=>{if(failing)throw new Error("SIMULATED_API_FAILURE");return store.update(path,fn);}}));
const source=fs.readFileSync(new URL("../../index.html",import.meta.url),"utf8");
const dbModule=`export function getDatabase(){return {};}
export function ref(db,path){return {path};}
export async function get(reference){const r=await fetch('/fixture-data?path='+encodeURIComponent(reference.path));if(!r.ok)throw new Error('SIMULATED_READ_FAILURE');const v=await r.json();return {exists:()=>v!==null,val:()=>v};}
export async function set(){throw new Error('DIRECT_WRITE_FORBIDDEN');}
export async function remove(){throw new Error('DIRECT_WRITE_FORBIDDEN');}
export async function runTransaction(){throw new Error('DIRECT_WRITE_FORBIDDEN');}`;
const server=http.createServer(async(req,res)=>{
  try {
    const base="http://127.0.0.1:"+server.address().port, url=new URL(req.url,base);
    if(url.pathname==="/fixture-data") {
      const path=url.searchParams.get("path")||"";
      if(!path.startsWith("rooms/"))throw new Error("Fixture room reads only");
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(await store.get(path)));return;
    }
    if(url.pathname==="/qa/failure") {failing=url.searchParams.get("on")==="1";res.end("Disposable fixture failure="+failing);return;}
    if(url.pathname==="/firebase-app.js"||url.pathname==="/firebase-database.js") {
      res.writeHead(200,{"Content-Type":"text/javascript"});res.end(url.pathname==="/firebase-app.js"?'export function initializeApp(){return {};}':dbModule);return;
    }
    if(url.pathname.startsWith("/api/")) {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const request=new Request(base+req.url,{method:req.method,headers:req.headers,...(req.method==="OPTIONS"?{}:{body:Buffer.concat(chunks)})});
      const response=await worker.fetch(request,{ALLOWED_ORIGIN:base,ADMIN_SIGNING_KEY:"fixture-signing-secret-".repeat(4),REGISTRATION_ENABLED:"true",AUTH_LIMIT:{limit:async()=>({success:true})},OP_LIMIT:{limit:async()=>({success:true})},DAILY_LIMIT:{limit:async()=>({success:true})}});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    let html=source.replace('var API_BASE = "";', 'var API_BASE = '+JSON.stringify(base)+';')
      .replace('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js',base+'/firebase-app.js')
      .replace('https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js',base+'/firebase-database.js');
    // Show native alert text in the DOM so browser automation can inspect it without modal focus issues.
    // Confirm affects disposable fixture resets only, never production data.
    html=html.replace('<script>', '<div id="qaMessage" role="status"></div><script>window.alert=function(message){document.getElementById("qaMessage").textContent=message;};window.confirm=function(){return true;};</script><script>');
    if(url.searchParams.get("variant")==="local")html=html.replace(/var FIREBASE_CONFIG = \{[\s\S]*?\n  \};/,'var FIREBASE_CONFIG = {};');
    if(url.searchParams.get("variant")==="partial")html=html.replace(/var FIREBASE_CONFIG = \{[\s\S]*?\n  \};/,'var FIREBASE_CONFIG = { databaseURL: "test-only" };');
    if(url.searchParams.get("variant")==="offline")html=html.replace(base+'/firebase-app.js',base+'/missing-module.js');
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html);
  } catch {res.writeHead(503);res.end("Fixture failure");}
});
server.listen(8847,"127.0.0.1",()=>console.log("Disposable browser QA: http://127.0.0.1:8847/?room=1037 ; test management code CP- followed by 32 Q characters. No production data."));
