import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FirebaseStore } from "../src/firebase.mjs";
import { randomCode } from "../src/crypto.mjs";
import { migrateRooms } from "../src/migration.mjs";
import { validKey } from "../src/worker.mjs";

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
try {
  if (!args.includes("--rooms")) throw new Error("Use --rooms 1037,7015; default is a read-only preview. Add --apply and --code-file <private path> to migrate.");
  const rooms = value("--rooms").split(",");
  if (!rooms.length || rooms.some(room => !validKey(room))) throw new Error("Invalid room IDs");
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Set FIREBASE_SERVICE_ACCOUNT_JSON locally; never paste a key into chat or commit it.");
  const store = new FirebaseStore({ FIREBASE_DATABASE_URL: "https://class-group-picker-default-rtdb.asia-southeast1.firebasedatabase.app", FIREBASE_PROJECT_ID: "class-group-picker", FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON });
  // Read all rooms before creating any private file or touching ownership.
  for (const roomId of rooms) {
    const room = await store.get("rooms/" + roomId);
    if (!room?.settings) throw new Error("Room missing: " + roomId);
    console.log(JSON.stringify({ roomId, assignments: Object.keys(room.assignments || {}).length, owned: !!room.ownerId, sessionPreserved: true }));
  }
  if (!args.includes("--apply")) { console.log("Preview only: no data changed."); process.exit(0); }
  if (!args.includes("--code-file") || !args.includes("--backup-dir")) throw new Error("--apply requires --code-file and --backup-dir outside every Git checkout.");
  const codePath = path.resolve(value("--code-file"));
  const backupDir = path.resolve(value("--backup-dir"));
  function checkPrivateLocation(target) {
    let existing = target;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("Private location does not exist");
      existing = parent;
    }
    let current = fs.realpathSync(existing);
    if (fs.statSync(current).isFile()) current = path.dirname(current);
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) throw new Error("Private files must stay outside every Git checkout.");
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const workspace = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const relative = path.relative(workspace, target);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Private files must stay outside this checkout.");
  }
  checkPrivateLocation(codePath); checkPrivateLocation(backupDir);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const roomId of rooms) {
    const room = await store.get("rooms/" + roomId);
    fs.writeFileSync(path.join(backupDir, "room-" + encodeURIComponent(roomId) + "-" + stamp + ".json"), JSON.stringify(room), { flag: "wx", mode: 0o600 });
  }
  let code;
  if (fs.existsSync(codePath)) code = fs.readFileSync(codePath, "utf8").trim();
  else { code = randomCode(); fs.writeFileSync(codePath, code + "\n", { flag: "wx", mode: 0o600 }); }
  await migrateRooms(store, code, rooms);
  console.log("Migration completed without resetting results. Management code is in the private code file; it is not printed.");
} catch (error) {
  // Avoid dumping OAuth / service account values even on a setup failure.
  console.error(error.message); process.exitCode = 1;
}
