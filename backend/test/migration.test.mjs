import test from "node:test";
import assert from "node:assert/strict";
import { migrateRooms } from "../src/migration.mjs";
import { randomCode, teacherId } from "../src/crypto.mjs";

class Store {
  constructor(rooms) { this.rooms = structuredClone(rooms); this.teachers = {}; }
  async get(path) { const parts=path.split("/"); return structuredClone(parts[0]==="rooms"?this.rooms[parts[1]]:this.teachers[parts[2]]); }
  async update(path,change) { const parts=path.split("/"); const target=parts[0]==="rooms"?this.rooms:this.teachers; const key=parts.at(-1);const next=change(structuredClone(target[key])); if(next!==undefined)target[key]=next;return next; }
}
test("migration links 1037 and 7015 to one teacher and only removes the old public management code",async()=>{
  const original={1037:{settings:{sessionId:"old-1037",resetCode:"old-public-code",lastResetDate:"2026-09-30",mode:"plainNumber"},assignments:{device:{sessionId:"old-1037",result:{id:"40"}}},groupCounts:{40:1}},7015:{settings:{sessionId:"old-7015",resetCode:"old-public-code",genderBalance:true},groupStats:{A1:{total:1,male:1,female:0}}}};
  const store=new Store(original),code=randomCode(),id=await teacherId(code);
  await migrateRooms(store,code,["1037","7015"]);
  for (const room of ["1037","7015"]) {
    const expected=structuredClone(original[room]);delete expected.settings.resetCode;expected.ownerId=id;
    assert.deepEqual(store.rooms[room],expected);
  }
  const once=structuredClone(store.rooms);await migrateRooms(store,code,["1037","7015"]);assert.deepEqual(store.rooms,once);
});
test("migration preflight refuses another owner's class before modifying either room",async()=>{
  const store=new Store({1037:{settings:{sessionId:"keep"}},7015:{ownerId:"different",settings:{sessionId:"keep"}}}),before=structuredClone(store.rooms);
  await assert.rejects(migrateRooms(store,randomCode(),["1037","7015"]));assert.deepEqual(store.rooms,before);assert.deepEqual(store.teachers,{});
});
