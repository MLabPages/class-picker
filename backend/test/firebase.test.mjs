import test from "node:test";
import assert from "node:assert/strict";
import { FirebaseStore } from "../src/firebase.mjs";

test("Firebase compare-and-swap retries conflicts instead of overwriting a concurrent draw", async()=>{
  let room={settings:{sessionId:"s"},assignments:{first:{result:{id:"A1"}}},groupCounts:{A1:1}}, version=1, conflict=true;
  const requests=[];
  const store=new FirebaseStore({FIREBASE_DATABASE_URL:"https://test-default-rtdb.asia-southeast1.firebasedatabase.app"},async(url,options)=>{
    requests.push({url,options});
    assert.equal(options.headers.Authorization,"Bearer test-token");assert.equal(new URL(url).search,"");
    if(options.method==="GET")return new Response(JSON.stringify(room),{headers:{etag:'"'+version+'"'}});
    if(conflict){conflict=false;room.assignments.second={result:{id:"B1"}};room.groupCounts.B1=1;version++;return new Response("{}",{status:412});}
    assert.equal(options.headers["if-match"],'"'+version+'"');room=JSON.parse(options.body);return new Response(JSON.stringify(room));
  });
  store.token=async()=>"test-token";
  await store.update("rooms/1037",old=>{old.ownerId="teacher";return old;});
  assert.equal(requests.length,4);assert.equal(room.ownerId,"teacher");assert.ok(room.assignments.first);assert.ok(room.assignments.second);assert.equal(room.groupCounts.B1,1);
});

test("service-account OAuth uses signed claims and caches the access token without putting it in a URL",async()=>{
  const pair=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  const key=Buffer.from(await crypto.subtle.exportKey("pkcs8",pair.privateKey)).toString("base64");
  const account={project_id:"test",client_email:"worker@test.iam.gserviceaccount.com",private_key:"-----BEGIN PRIVATE KEY-----\n"+key+"\n-----END PRIVATE KEY-----\n"};
  let grants=0;
  const store=new FirebaseStore({FIREBASE_DATABASE_URL:"https://test.firebaseio.com",FIREBASE_PROJECT_ID:"test",FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(account)},async(url,options)=>{
    if(url==="https://oauth2.googleapis.com/token") {
      grants++;const parts=options.body.get("assertion").split(".");
      assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5",pair.publicKey,Buffer.from(parts[2],"base64url"),new TextEncoder().encode(parts[0]+"."+parts[1])),true);
      const claims=JSON.parse(Buffer.from(parts[1],"base64url").toString());
      assert.equal(claims.iss,account.client_email);assert.equal(claims.aud,url);assert.match(claims.scope,/userinfo.email/);assert.match(claims.scope,/firebase.database/);assert.equal(claims.exp-claims.iat,3600);
      return new Response(JSON.stringify({access_token:"fixture-token",expires_in:3600}));
    }
    assert.equal(new URL(url).search,"");assert.equal(options.headers.Authorization,"Bearer fixture-token");return new Response("null",{headers:{etag:'"0"'}});
  });
  await store.get("rooms/1037");await store.get("rooms/7015");assert.equal(grants,1);
});
test("Firebase adapter rejects arbitrary hosts, credentials, traversal and missing conditional-write support",async()=>{
  for(const url of ["http://test.firebaseio.com","https://evil.example","https://u:p@test.firebaseio.com","https://test.firebaseio.com/path","https://test.firebaseio.com/?auth=secret"])assert.throws(()=>new FirebaseStore({FIREBASE_DATABASE_URL:url}));
  const store=new FirebaseStore({FIREBASE_DATABASE_URL:"https://test.firebaseio.com"},async()=>new Response("{}"));store.token=async()=>"test";
  for(const p of ["rooms/1037/settings","control/teachers/private/extra","rooms/..","rooms/__proto__","control/teachers/a#auth"])await assert.rejects(store.get(p));
  await assert.rejects(store.update("rooms/1037",()=>({})),/conditional/);
});
