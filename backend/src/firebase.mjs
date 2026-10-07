import { base64url } from "./crypto.mjs";

// No user-supplied URL, query, or path is forwarded to Firebase.
export class FirebaseStore {
  constructor(env, fetcher = (input, init) => fetch(input, init)) {
    this.env = env; this.fetcher = fetcher; this.accessToken = null;
    const url = new URL(env.FIREBASE_DATABASE_URL);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(?:firebasedatabase\.app|firebaseio\.com)$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid database configuration");
    this.url = url.origin;
  }
  async token() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60000) return this.accessToken.value;
    let account;
    try { account = JSON.parse(this.env.FIREBASE_SERVICE_ACCOUNT_JSON); }
    catch { throw new Error("Invalid service account configuration"); }
    if (account.project_id !== this.env.FIREBASE_PROJECT_ID || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(account.client_email)) throw new Error("Invalid service account");
    const keyBytes = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const now = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const head = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const body = base64url(enc.encode(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
    const input = head + "." + body;
    const assertion = input + "." + base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input)));
    const res = await this.fetcher("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }), redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (res.status >= 300 && res.status < 400 || !res.ok) throw new Error("Firebase authentication failed");
    let data;
    try { data = await res.json(); } catch { throw new Error("Firebase authentication failed"); }
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in)) throw new Error("Firebase authentication failed");
    this.accessToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }
  async request(path, method = "GET", value, etag) {
    const parts = path.split("/");
    const allowed = parts.length === 2 && parts[0] === "rooms" || parts.length === 3 && parts[0] === "control" && parts[1] === "teachers";
    if (!allowed || parts.some(p => !p || p.length > 128 || /[.#$\[\]\x00-\x20\x7f]/.test(p) || ["__proto__", "constructor", "prototype"].includes(p))) throw new Error("Invalid database path");
    const headers = { Authorization: "Bearer " + await this.token(), "Content-Type": "application/json" };
    if (method === "GET") headers["X-Firebase-ETag"] = "true";
    if (etag) headers["if-match"] = etag;
    const res = await this.fetcher(this.url + "/" + path.split("/").map(encodeURIComponent).join("/") + ".json", { method, headers, body: method === "GET" ? undefined : JSON.stringify(value), redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (res.status >= 300 && res.status < 400) throw new Error("Firebase redirect refused");
    if (res.status === 412) return { conflict: true };
    if (!res.ok) throw new Error("Firebase request failed");
    return { value: await res.json(), etag: res.headers.get("etag") };
  }
  async get(path) { return (await this.request(path)).value; }
  async update(path, change) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = await this.request(path);
      if (!current.etag) throw new Error("Firebase conditional writes unavailable");
      const next = change(current.value);
      if (next === undefined) return current.value;
      const written = await this.request(path, "PUT", next, current.etag);
      if (!written.conflict) return next;
      // Spread concurrent classroom requests; synchronized retries would repeatedly collide.
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * Math.min(400, 40 * (attempt + 1))));
    }
    throw new Error("Concurrent updates; retry required");
  }
}
