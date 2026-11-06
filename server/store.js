// Storage selector: MongoDB (db.js) when MONGODB_URI is set, otherwise the
// local file-backed store (localstore.js) used by test mode.
const useLocal = !process.env.MONGODB_URI;
const impl = useLocal ? await import("./localstore.js") : await import("./db.js");

export const dbConfigured = impl.dbConfigured;
export const connectDb = impl.connectDb;
export const saveFile = impl.saveFile;
export const readFile = impl.readFile;
export const nextTaskId = impl.nextTaskId;
export const tasks = impl.tasks;
export const episodesCol = impl.episodesCol;
export const storageKind = useLocal ? "local (test mode)" : "mongodb";
