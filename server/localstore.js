// Local file-backed storage for TEST MODE ONLY (no MongoDB server needed).
// Implements the same interface as db.js: task documents live in
// .testdata/tasks.json + episodes.json, file blobs in .testdata/files/.
// Single-process, JSON-on-disk — perfect for trying the tool on your own
// machine; production always uses MongoDB (db.js).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".testdata");
const FILES_DIR = path.join(ROOT, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

function loadJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
  } catch {
    return [];
  }
}
function saveJson(name, data) {
  fs.writeFileSync(path.join(ROOT, name), JSON.stringify(data, null, 1));
}

export function dbConfigured() {
  return true;
}
export async function connectDb() {
  return null;
}

export async function saveFile(buffer, { filename }) {
  const id = randomUUID();
  fs.writeFileSync(path.join(FILES_DIR, id), buffer);
  fs.writeFileSync(path.join(FILES_DIR, id + ".json"), JSON.stringify({ filename }));
  return id;
}

export async function readFile(id) {
  return fs.readFileSync(path.join(FILES_DIR, String(id)));
}

let counter = null;
export async function nextTaskId() {
  if (counter === null) {
    try {
      counter = JSON.parse(fs.readFileSync(path.join(ROOT, "counter.json"), "utf8")).seq;
    } catch {
      counter = 0;
    }
  }
  counter += 1;
  fs.writeFileSync(path.join(ROOT, "counter.json"), JSON.stringify({ seq: counter }));
  return `PR-${1000 + counter}`;
}

function matches(doc, query) {
  return Object.entries(query).every(([k, v]) => doc[k] === v);
}

function makeCollection(file) {
  return {
    async findOne(query) {
      return loadJson(file).find((d) => matches(d, query)) || null;
    },
    async insertOne(doc) {
      const all = loadJson(file);
      all.push(doc);
      saveJson(file, all);
      return { insertedId: doc.taskId || doc._id };
    },
    async updateOne(query, update, opts = {}) {
      const all = loadJson(file);
      const doc = all.find((d) => matches(d, query));
      if (doc) {
        Object.assign(doc, update.$set || {});
        saveJson(file, all);
        return { matchedCount: 1 };
      }
      if (opts.upsert) {
        all.push({ ...query, ...(update.$set || {}) });
        saveJson(file, all);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0 };
    },
    find(query) {
      let rows = loadJson(file).filter((d) => matches(d, query || {}));
      const cursor = {
        sort(spec) {
          const [k, dir] = Object.entries(spec)[0];
          rows = rows.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir);
          return cursor;
        },
        limit(n) {
          rows = rows.slice(0, n);
          return cursor;
        },
        async toArray() {
          return rows;
        },
      };
      return cursor;
    },
  };
}

export const tasks = () => makeCollection("tasks.json");
export const episodesCol = () => makeCollection("episodes.json");
