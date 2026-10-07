import test from "node:test";
import assert from "node:assert/strict";
import { makeWorker } from "../src/worker.mjs";
import { cleanSettings, groupsFor, todayKey } from "../src/layout.mjs";
import { verifySession } from "../src/crypto.mjs";

export class MemoryStore {
  constructor(data = {}) { this.data = structuredClone(data); this.pending = Promise.resolve(); }
  locate(path) { const parts = path.split("/"); const leaf = parts.pop(); let parent = this.data; for (const key of parts) parent = parent[key] ||= {}; return [parent, leaf]; }
  async get(path) { const [p,k] = this.locate(path); return structuredClone(p[k] ?? null); }
  async update(path, change) {
    const work = this.pending.then(async () => {
      const [p,k] = this.locate(path); const next = change(structuredClone(p[k] ?? null));
      if (next !== undefined) p[k] = structuredClone(next);
      return structuredClone(p[k] ?? null);
    });
    this.pending = work.catch(() => {}); return work;
  }
}
const origin = "https://mlabpages.github.io";
function fixture() {
  const store = new MemoryStore();
  const env = { ALLOWED_ORIGIN: origin, ADMIN_SIGNING_KEY: "a".repeat(64), REGISTRATION_ENABLED: "true", AUTH_LIMIT: { limit: async () => ({ success: true }) }, OP_LIMIT: { limit: async () => ({ success: true }) }, DAILY_LIMIT: { limit: async () => ({ success: true }) } };
  const worker = makeWorker(() => store);
  async function call(path, body, token, extra = {}) {
    const headers = { origin, "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...extra.headers };
    const response = await worker.fetch(new Request("https://api.example.test" + path, { method: extra.method || "POST", headers, ...(extra.method === "OPTIONS" || extra.method === "GET" ? {} : { body: JSON.stringify(body) }) }), env);
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  return { store, env, call, worker };
}
function settings(overrides = {}) {
  const s = cleanSettings({ totalStudents: 8, groupSize: 4, columnCount: 2, ...overrides });
  delete s.sessionId; delete s.lastResetDate; return s;
}
async function teacher(f) { const r = await f.call("/api/teachers", {}); assert.equal(r.status,201); return r.body; }
async function room(f, t, roomId, overrides = {}) {
  const r = await f.call("/api/rooms/create", { roomId, settings: settings(overrides) }, t.token); assert.equal(r.status,201); return r.body.settings;
}
function drawBody(roomId, s, deviceId, gender = "") { return { roomId, sessionId: s.sessionId, deviceId, gender }; }

test("one teacher code authorizes both 1037 and 7015; another teacher cannot mutate either", async () => {
  const f = fixture(), a = await teacher(f), b = await teacher(f);
  assert.match(a.code,/^CP-[A-Za-z0-9_-]{32}$/);
  const login = await f.call("/api/session", { code: a.code }); assert.equal(login.status,200);
  for (const id of ["1037", "7015"]) {
    const s = await room(f,a,id);
    await f.call("/api/draw",drawBody(id,s,"student-1"));
    const before = await f.store.get("rooms/"+id);
    for (const token of [undefined,b.token,a.token.slice(0,-2)+"xx"]) {
      for (const [path,body] of [["/api/rooms/settings",{roomId:id,settings:settings({totalStudents:12})}], ["/api/rooms/reset",{roomId:id}], ["/api/rooms/reset-device",{roomId:id,deviceId:"student-1"}]]) {
        const r = await f.call(path,body,token); assert.ok([401,403].includes(r.status));
        assert.deepEqual(await f.store.get("rooms/"+id),before);
      }
    }
    assert.equal((await f.call("/api/rooms/settings",{roomId:id,settings:settings()},login.body.token)).status,200);
  }
  assert.equal((await f.call("/api/session",{code:"reset2026"})).status,401);
  assert.equal((await f.call("/api/session",{code:a.code.slice(0,-1)+"!"})).status,401);
  assert.equal(JSON.stringify(f.store.data).includes(a.code),false);
});

test("new teachers cannot claim an existing or unmigrated room", async () => {
  const f = fixture(), t = await teacher(f);
  const old = { settings:cleanSettings({sessionId:"legacy",totalStudents:8}), assignments:{old:{sessionId:"legacy",result:{id:"A1"}}}, groupCounts:{A1:1} };
  await f.store.update("rooms/1037",()=>old);
  assert.equal((await f.call("/api/rooms/create",{roomId:"1037",settings:settings()},t.token)).status,409);
  assert.deepEqual(await f.store.get("rooms/1037"),old);
  assert.equal((await f.call("/api/rooms/reset",{roomId:"1037"},t.token)).status,404);
});

test("student draws atomically reserve capacity and preserve an existing result on retry", async () => {
  const f = fixture(), t = await teacher(f), s = await room(f,t,"1037");
  const responses = await Promise.all(Array.from({length:20},(_,i)=>f.call("/api/draw",drawBody("1037",s,"student-"+i))));
  assert.equal(responses.filter(r=>r.body.result).length,8);
  const state = await f.store.get("rooms/1037");
  assert.deepEqual(Object.values(state.groupCounts).sort(),[4,4]); assert.equal(Object.keys(state.assignments).length,8);
  const result = state.assignments["student-0"].result;
  assert.deepEqual((await f.call("/api/draw",drawBody("1037",s,"student-0"))).body.result,result);
  assert.deepEqual(await f.store.get("rooms/1037"),state);
});

test("gender balance prefers half capacity and uses remaining slots for a skewed ratio", async () => {
  const f = fixture(), t = await teacher(f), s = await room(f,t,"1037",{genderBalance:true});
  for (let i=0;i<8;i++) assert.equal((await f.call("/api/draw",drawBody("1037",s,"d"+i,"male"))).status,200);
  const state=await f.store.get("rooms/1037");
  assert.deepEqual(Object.values(state.groupStats).map(x=>x.total).sort(),[4,4]);
  assert.equal(Object.values(state.assignments).filter(x=>x.result.genderRelaxed).length,4);
  assert.equal((await f.call("/api/draw",drawBody("1037",s,"extra","male"))).body.result,null);
});

test("settings without layout changes preserve results; layout change resets exactly the owned room", async () => {
  const f=fixture(),t=await teacher(f),a=await room(f,t,"1037"),b=await room(f,t,"7015");
  await f.call("/api/draw",drawBody("1037",a,"d1")); await f.call("/api/draw",drawBody("7015",b,"d2"));
  const old=await f.store.get("rooms/1037"),other=await f.store.get("rooms/7015");
  const saved=await f.call("/api/rooms/settings",{roomId:"1037",settings:settings({autoDailyReset:true})},t.token);
  assert.equal(saved.body.reset,false); assert.deepEqual((await f.store.get("rooms/1037")).assignments,old.assignments);
  const changed=await f.call("/api/rooms/settings",{roomId:"1037",settings:settings({totalStudents:12})},t.token);
  assert.equal(changed.body.reset,true); assert.notEqual(changed.body.settings.sessionId,a.sessionId);
  assert.equal((await f.store.get("rooms/1037")).assignments,undefined); assert.deepEqual(await f.store.get("rooms/7015"),other);
  assert.equal((await f.call("/api/draw",drawBody("1037",a,"stale"))).status,409);
});

test("device reset decrements only the stored assignment once; never accepts a client count", async () => {
  for (const genderBalance of [false,true]) {
    const f=fixture(),t=await teacher(f),s=await room(f,t,"1037",{genderBalance});
    const r=await f.call("/api/draw",drawBody("1037",s,"d1",genderBalance?"female":""));
    const result=r.body.result;
    assert.equal((await f.call("/api/rooms/reset-device",{roomId:"1037",deviceId:"d1",count:999},t.token)).status,400);
    for (let i=0;i<2;i++) assert.equal((await f.call("/api/rooms/reset-device",{roomId:"1037",deviceId:"d1"},t.token)).status,200);
    const state=await f.store.get("rooms/1037");
    assert.equal(state.assignments.d1,undefined);
    assert.equal(genderBalance?state.groupStats[result.id].total:state.groupCounts[result.id],0);
  }
});

test("daily reset is public only when opted in and overdue; repeated calls cannot reset again", async () => {
  const f=fixture(),t=await teacher(f),s=await room(f,t,"1037");
  await f.call("/api/draw",drawBody("1037",s,"d1")); const initial=await f.store.get("rooms/1037");
  await f.call("/api/daily-reset",{roomId:"1037"}); assert.deepEqual(await f.store.get("rooms/1037"),initial);
  await f.store.update("rooms/1037",old=>{old.settings.autoDailyReset=true;old.settings.lastResetDate="2026-01-01";return old;});
  const r=await f.call("/api/daily-reset",{roomId:"1037"});assert.equal(r.status,200);assert.equal(r.body.settings.lastResetDate,todayKey());
  assert.notEqual(r.body.settings.sessionId,s.sessionId);
  await f.call("/api/draw",drawBody("1037",r.body.settings,"d1")); const state=await f.store.get("rooms/1037");
  await f.call("/api/daily-reset",{roomId:"1037"}); assert.deepEqual(await f.store.get("rooms/1037"),state);
});

test("origin, MIME, method, size, path aliases and extra privilege fields are rejected", async () => {
  const f=fixture(),t=await teacher(f);
  const wrong=await f.call("/api/rooms/reset",{roomId:"1037"},t.token,{headers:{origin:"https://evil.example"}});
  assert.equal(wrong.status,403);assert.equal(wrong.headers.get("access-control-allow-origin"),null);
  assert.equal((await f.call("/api/session",{},null,{headers:{"content-type":"text/plain"}})).status,415);
  assert.equal((await f.call("/api/session",{},null,{method:"GET"})).status,405);
  assert.equal((await f.call("/api/session",{code:"x".repeat(17000)})).status,413);
  for (const roomId of ["../control","x/y","__proto__","constructor","1037\u0000", "a".repeat(65)]) assert.equal((await f.call("/api/rooms/reset",{roomId},t.token)).status,400);
  assert.equal((await f.call("/api/rooms/create",{roomId:"1037",settings:{...settings(),ownerId:"other"}},t.token)).status,400);
  assert.equal((await f.call("/api/session?code=secret",{code:t.code})).status,400);
  assert.equal((await f.call("/api/session",{},null,{method:"OPTIONS"})).status,204);
});

test("expired or disabled teacher sessions and missing rate limits fail closed", async () => {
  const f=fixture(),t=await teacher(f);
  assert.equal(await verifySession(t.token,f.env.ADMIN_SIGNING_KEY,t.expiresAt),null);
  const id=await verifySession(t.token,f.env.ADMIN_SIGNING_KEY);
  await f.store.update("control/teachers/"+id,old=>({...old,disabled:true}));
  assert.equal((await f.call("/api/rooms/create",{roomId:"1037",settings:settings()},t.token)).status,401);
  assert.equal((await f.call("/api/session",{code:t.code})).status,401);
  f.env.AUTH_LIMIT={limit:async()=>({success:false})}; assert.equal((await f.call("/api/session",{code:t.code})).status,429);
  delete f.env.AUTH_LIMIT; assert.equal((await f.call("/api/teachers",{})).status,503);
});

test("backend failures never disclose secrets or partially update an assignment", async () => {
  const f=fixture(),t=await teacher(f),s=await room(f,t,"1037");
  const before=await f.store.get("rooms/1037");
  f.store.update=async()=>{throw new Error("private-key fixture credential");};
  const r=await f.call("/api/draw",drawBody("1037",s,"d1"));
  assert.equal(r.status,503); assert.doesNotMatch(JSON.stringify(r.body),/private-key|fixture credential/);
  assert.deepEqual(await f.store.get("rooms/1037"),before);
});
