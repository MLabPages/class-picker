import { FirebaseStore } from "./firebase.mjs";
import { issueSession, randomCode, teacherId, verifySession } from "./crypto.mjs";
import { cleanSettings, groupsFor, todayKey } from "./layout.mjs";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireCondition(ok, status, message) { if (!ok) throw new HttpError(status, message); }
export function validKey(value, max = 64) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[.#$\/\[\]\x00-\x20\x7f]/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}
function exactKeys(body, keys) {
  requireCondition(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(k => keys.includes(k)), 400, "入力形式が正しくありません。");
}
function resetRoom(room) {
  room.settings = { ...cleanSettings(room.settings), lastResetDate: todayKey(), sessionId: crypto.randomUUID() };
  delete room.assignments; delete room.groupCounts; delete room.groupStats;
  return room;
}
function roomExists(room) { requireCondition(room && room.ownerId && room.settings, 404, "この参加コードは未作成か，移行前です。教員に確認してください。"); }
function owns(room, id) { roomExists(room); requireCondition(room.ownerId === id, 403, "この参加コードの管理権限がありません。"); }
function layoutChanged(a, b) {
  return ["mode", "totalStudents", "groupSize", "remainderMode", "columnFillMode", "columnCount", "rowLimitPerColumn", "columnRowLimits", "genderBalance"].some(k => a[k] !== b[k]);
}
function validateSettings(input) {
  exactKeys(input, ["mode", "totalStudents", "groupSize", "remainderMode", "columnFillMode", "columnCount", "rowLimitPerColumn", "columnRowLimits", "autoDailyReset", "genderBalance"]);
  requireCondition(["number", "plainNumber", "fruit"].includes(input.mode) && ["balanced", "singleExtra"].includes(input.remainderMode) && ["fill", "even"].includes(input.columnFillMode), 400, "表示設定が正しくありません。");
  for (const [key, min, max] of [["totalStudents", 1, 600], ["groupSize", 1, 20], ["columnCount", 1, 12], ["rowLimitPerColumn", 0, 30]]) requireCondition(Number.isInteger(input[key]) && input[key] >= min && input[key] <= max, 400, "人数・列数が範囲外です。");
  requireCondition(typeof input.columnRowLimits === "string" && input.columnRowLimits.length <= 256 && typeof input.autoDailyReset === "boolean" && typeof input.genderBalance === "boolean", 400, "表示設定が正しくありません。");
  return cleanSettings(input);
}
function chooseResult(room, gender) {
  const s = cleanSettings(room.settings), groups = groupsFor(s);
  const balanced = s.genderBalance;
  requireCondition(!balanced || ["male", "female"].includes(gender), 400, "抽選前に性別を選択してください。");
  function candidates(relaxed) {
    return groups.map(group => {
      const stat = room.groupStats?.[group.id] || {};
      const total = balanced ? stat.total || 0 : room.groupCounts?.[group.id] || 0;
      const same = balanced ? stat[gender] || 0 : 0;
      return { group, total, same, tie: crypto.getRandomValues(new Uint32Array(1))[0] };
    }).filter(c => c.total < c.group.capacity && (!balanced || relaxed || c.same < Math.ceil(c.group.capacity / 2)))
      .sort((a, b) => a.total - b.total || a.same - b.same || a.tie - b.tie);
  }
  let selected = candidates(false)[0], relaxed = false;
  if (!selected && balanced) { selected = candidates(true)[0]; relaxed = true; }
  if (!selected) return null;
  const result = { ...selected.group };
  if (balanced) {
    result.assignedGender = gender; result.genderRelaxed = relaxed;
    room.groupStats ||= {};
    const stat = room.groupStats[result.id] || { total: 0, male: 0, female: 0 };
    room.groupStats[result.id] = { total: (stat.total || 0) + 1, male: (stat.male || 0) + (gender === "male" ? 1 : 0), female: (stat.female || 0) + (gender === "female" ? 1 : 0) };
  } else {
    room.groupCounts ||= {}; room.groupCounts[result.id] = selected.total + 1;
  }
  return result;
}
async function readBody(request) {
  requireCondition((request.headers.get("content-type") || "").split(";")[0].trim() === "application/json", 415, "JSON形式で送信してください。");
  requireCondition(!Number.isFinite(Number(request.headers.get("content-length"))) || Number(request.headers.get("content-length")) <= 16384, 413, "入力が大きすぎます。");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "入力がありません。");
  const chunks = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > 16384) { await reader.cancel(); throw new HttpError(413, "入力が大きすぎます。"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new HttpError(400, "入力形式が正しくありません。"); }
}
async function rateLimit(binding, key) {
  requireCondition(binding && typeof binding.limit === "function", 503, "サーバーの設定が未完了です。");
  requireCondition((await binding.limit({ key })).success, 429, "操作が続いています。1分ほど待って再試行してください。");
}
export function makeWorker(createStore = env => new FirebaseStore(env)) {
  return {
    async fetch(request, env) {
      const allowed = env.ALLOWED_ORIGIN;
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin" };
      const origin = request.headers.get("origin");
      if (origin === allowed) headers["Access-Control-Allow-Origin"] = allowed;
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
      try {
        requireCondition(typeof allowed === "string" && origin === allowed, 403, "この送信元からは操作できません。");
        requireCondition(typeof env.ADMIN_SIGNING_KEY === "string" && env.ADMIN_SIGNING_KEY.length >= 43, 503, "サーバーの設定が未完了です。");
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "600" } });
        requireCondition(request.method === "POST", 405, "POSTで送信してください。");
        const url = new URL(request.url);
        requireCondition(!url.search, 400, "クエリ指定はできません。");
        const path = url.pathname;
        requireCondition(["/api/teachers", "/api/session", "/api/rooms/create", "/api/rooms/settings", "/api/rooms/reset", "/api/rooms/reset-device", "/api/draw", "/api/daily-reset"].includes(path), 404, "操作が見つかりません。");
        const body = await readBody(request), store = createStore(env);
        requireCondition(body && typeof body === "object" && !Array.isArray(body), 400, "入力形式が正しくありません。");
        if (path === "/api/teachers" || path === "/api/session") {
          await rateLimit(env.AUTH_LIMIT, "auth:" + (request.headers.get("cf-connecting-ip") || "unknown"));
          if (path === "/api/teachers") {
            exactKeys(body, []);
            requireCondition(env.REGISTRATION_ENABLED === "true", 403, "新規作成は停止しています。");
            const code = randomCode(), id = await teacherId(code);
            await store.update("control/teachers/" + id, old => { requireCondition(!old, 409, "再試行してください。"); return { createdAt: Date.now(), disabled: false }; });
            return reply({ code, ...await issueSession(id, env.ADMIN_SIGNING_KEY) }, 201);
          }
          exactKeys(body, ["code"]);
          const id = await teacherId(body.code), record = id && await store.get("control/teachers/" + id);
          requireCondition(record && record.disabled === false, 401, "管理コードが違うか，無効になっています。");
          return reply(await issueSession(id, env.ADMIN_SIGNING_KEY));
        }
        requireCondition(validKey(body.roomId), 400, "参加コードが正しくありません。");
        const roomPath = "rooms/" + body.roomId;
        if (path === "/api/draw" || path === "/api/daily-reset") {
          if (path === "/api/daily-reset") {
            exactKeys(body, ["roomId"]);
            await rateLimit(env.DAILY_LIMIT, "daily:" + body.roomId);
            const room = await store.update(roomPath, old => {
              roomExists(old);
              if (!old.settings.autoDailyReset || old.settings.lastResetDate >= todayKey()) return undefined;
              return resetRoom(old);
            });
            return reply({ settings: cleanSettings(room.settings) });
          }
          exactKeys(body, ["roomId", "deviceId", "gender", "sessionId"]);
          requireCondition(validKey(body.deviceId, 128) && typeof body.sessionId === "string" && body.sessionId.length <= 128 && ["", "male", "female"].includes(body.gender), 400, "抽選情報が正しくありません。");
          await rateLimit(env.OP_LIMIT, "draw:" + body.roomId + ":" + body.deviceId);
          let result = null;
          await store.update(roomPath, room => {
            roomExists(room);
            requireCondition(body.sessionId === room.settings.sessionId, 409, "設定が変わりました。再接続してください。");
            const previous = room.assignments?.[body.deviceId];
            if (previous?.sessionId === room.settings.sessionId) { result = previous.result; return undefined; }
            result = chooseResult(room, body.gender);
            if (!result) return undefined;
            room.assignments ||= {};
            room.assignments[body.deviceId] = { result, sessionId: room.settings.sessionId, date: todayKey(), createdAt: Date.now() };
            return room;
          });
          return reply({ result });
        }
        const auth = request.headers.get("authorization") || "";
        const id = await verifySession(auth.startsWith("Bearer ") ? auth.slice(7) : "", env.ADMIN_SIGNING_KEY);
        requireCondition(id, 401, "管理コードを入力してください。確認は8時間有効です。");
        const teacher = await store.get("control/teachers/" + id);
        requireCondition(teacher?.disabled === false, 401, "この管理コードは無効です。");
        await rateLimit(env.OP_LIMIT, "admin:" + id);
        let changed = false;
        if (path === "/api/rooms/create") {
          exactKeys(body, ["roomId", "settings"]); const settings = validateSettings(body.settings);
          const room = await store.update(roomPath, old => {
            requireCondition(!old, 409, "この参加コードは使用中です。別のコードを作成してください。");
            return { ownerId: id, settings: { ...settings, sessionId: crypto.randomUUID(), lastResetDate: todayKey() } };
          });
          return reply({ settings: room.settings }, 201);
        }
        if (path === "/api/rooms/settings") {
          exactKeys(body, ["roomId", "settings"]); const next = validateSettings(body.settings);
          const room = await store.update(roomPath, old => {
            owns(old, id); const previous = cleanSettings(old.settings);
            changed = layoutChanged(previous, next);
            old.settings = { ...next, sessionId: previous.sessionId, lastResetDate: previous.lastResetDate };
            return changed ? resetRoom(old) : old;
          });
          return reply({ settings: room.settings, reset: changed });
        }
        if (path === "/api/rooms/reset") {
          exactKeys(body, ["roomId"]);
          const room = await store.update(roomPath, old => { owns(old, id); return resetRoom(old); });
          return reply({ settings: room.settings });
        }
        exactKeys(body, ["roomId", "deviceId"]);
        requireCondition(validKey(body.deviceId, 128), 400, "端末情報が正しくありません。");
        const room = await store.update(roomPath, old => {
          owns(old, id);
          const assignment = old.assignments?.[body.deviceId];
          if (!assignment) return undefined;
          const r = assignment.result;
          if (assignment.sessionId === old.settings.sessionId && r && validKey(r.id)) {
            if (r.assignedGender) {
              const stat = old.groupStats?.[r.id];
              if (stat) { stat.total = Math.max(0, (stat.total || 0) - 1); stat[r.assignedGender] = Math.max(0, (stat[r.assignedGender] || 0) - 1); }
            } else if (old.groupCounts?.[r.id]) old.groupCounts[r.id] = Math.max(0, old.groupCounts[r.id] - 1);
          }
          delete old.assignments[body.deviceId];
          return old;
        });
        return reply({ settings: cleanSettings(room.settings) });
      } catch (error) {
        // Never return Firebase errors, request bodies, management codes, or credentials.
        return reply({ error: error instanceof HttpError ? error.message : "サーバーに接続できません。保存データを確認してから再試行してください。" }, error instanceof HttpError ? error.status : 503);
      }
    }
  };
}
const stores = new WeakMap();
export default makeWorker(env => {
  if (!stores.has(env)) stores.set(env, new FirebaseStore(env));
  return stores.get(env);
});
