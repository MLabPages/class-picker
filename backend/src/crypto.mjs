const encoder = new TextEncoder();
export function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function decode64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
export function randomCode() { return "CP-" + base64url(crypto.getRandomValues(new Uint8Array(24))); }
export async function teacherId(code) {
  if (typeof code !== "string" || !/^CP-[A-Za-z0-9_-]{32}$/.test(code)) return null;
  return base64url(await crypto.subtle.digest("SHA-256", encoder.encode("class-picker-teacher-v1:" + code)));
}
async function signingKey(secret) {
  if (typeof secret !== "string" || secret.length < 43) throw new Error("Signing secret missing");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function issueSession(id, secret, now = Date.now()) {
  const payload = base64url(encoder.encode(JSON.stringify({ sub: id, aud: "class-picker-admin-v1", iat: now, exp: now + 8 * 60 * 60 * 1000 })));
  const signature = base64url(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload)));
  return { token: payload + "." + signature, expiresAt: now + 8 * 60 * 60 * 1000 };
}
export async function verifySession(token, secret, now = Date.now()) {
  try {
    if (typeof token !== "string" || token.length > 1024) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", await signingKey(secret), decode64(parts[1]), encoder.encode(parts[0]))) return null;
    const p = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.sub) || p.aud !== "class-picker-admin-v1" || !Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || p.iat > now || p.exp <= now || p.exp - p.iat !== 28800000) return null;
    return p.sub;
  } catch { return null; }
}
