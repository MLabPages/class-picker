import { teacherId } from "./crypto.mjs";
import { validKey } from "./worker.mjs";

// Trusted operator only; there is deliberately no HTTP route to claim legacy rooms.
export async function migrateRooms(store, code, roomIds) {
  const id = await teacherId(code);
  if (!id || !Array.isArray(roomIds) || !roomIds.length || roomIds.some(room => !validKey(room))) throw new Error("Invalid migration input");
  for (const roomId of roomIds) {
    const room = await store.get("rooms/" + roomId);
    if (!room?.settings || (room.ownerId && room.ownerId !== id)) throw new Error("Room unavailable or already owned: " + roomId);
  }
  await store.update("control/teachers/" + id, old => {
    if (old && old.disabled !== false) throw new Error("Teacher disabled");
    return old || { createdAt: Date.now(), disabled: false };
  });
  for (const roomId of roomIds) {
    await store.update("rooms/" + roomId, room => {
      if (!room?.settings || (room.ownerId && room.ownerId !== id)) throw new Error("Room unavailable or already owned: " + roomId);
      room.ownerId = id;
      delete room.settings.resetCode;
      // Assignment records, counts, session IDs, date and display settings stay intact.
      return room;
    });
  }
  return { roomIds: [...roomIds] };
}
