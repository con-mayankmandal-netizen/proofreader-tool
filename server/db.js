// MongoDB storage: tasks collection + GridFS bucket "files" for the
// uploaded originals and the generated outputs.
import { MongoClient, GridFSBucket, ObjectId } from "mongodb";

let client = null;
let db = null;
let bucket = null;

export function dbConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

export async function connectDb() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  try {
    await client.connect();
  } catch (e) {
    client = null;
    throw e;
  }
  db = client.db(process.env.MONGODB_DB || undefined);
  bucket = new GridFSBucket(db, { bucketName: "files" });
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not connected");
  return db;
}

export async function saveFile(buffer, { filename, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, { contentType, metadata });
    stream.on("error", reject);
    stream.on("finish", () => resolve(stream.id));
    stream.end(buffer);
  });
}

export async function readFile(id) {
  const chunks = [];
  const stream = bucket.openDownloadStream(typeof id === "string" ? new ObjectId(id) : id);
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function nextTaskId() {
  const r = await getDb()
    .collection("counters")
    .findOneAndUpdate({ _id: "taskId" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return `PR-${1000 + r.seq}`;
}

export const tasks = () => getDb().collection("tasks");
export const episodesCol = () => getDb().collection("episodes");
