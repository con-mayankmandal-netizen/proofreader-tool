// Proofreader Tool — web server.
// Submit a task (show, languages, source .docx + LS .xlsx + adapted .docx),
// processing runs in the background, and the task page offers downloads of
// the input originals and, once Ready, the three outputs.
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb, dbConfigured, saveFile, readFile, nextTaskId, tasks, episodesCol } from "./db.js";
import { processTask } from "./process.js";
import { callModel, providerConfig } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const FILE_KINDS = {
  source: { field: "sourceFileId", fallback: "Source script.docx" },
  adapted: { field: "adaptedFileId", fallback: "Adapted script.docx" },
  ls: { field: "lsFileId", fallback: "LS sheet.xlsx" },
  review: { field: "reviewFileId", fallback: "Review (highlighted, not applied).docx" },
  corrected: { field: "correctedFileId", fallback: "Corrected.docx" },
  changelog: { field: "changelogFileId", fallback: "Change log.xlsx" },
};

function publicTask(t) {
  if (!t) return null;
  const { sourceFileId, adaptedFileId, lsFileId, reviewFileId, correctedFileId, changelogFileId, ...rest } = t;
  return {
    ...rest,
    files: {
      source: Boolean(sourceFileId),
      adapted: Boolean(adaptedFileId),
      ls: Boolean(lsFileId),
      review: Boolean(reviewFileId),
      corrected: Boolean(correctedFileId),
      changelog: Boolean(changelogFileId),
    },
  };
}

async function runTask(taskId) {
  const col = tasks();
  const task = await col.findOne({ taskId });
  if (!task) return;
  let conf;
  try {
    conf = providerConfig();
    if (!conf.key) throw new Error(`No API key set for provider "${conf.provider}"`);
  } catch (e) {
    await col.updateOne({ taskId }, { $set: { status: "Failed", error: e.message, updatedAt: new Date() } });
    return;
  }
  await col.updateOne({ taskId }, { $set: { status: "Processing", updatedAt: new Date(), error: null } });
  try {
    const [source, adapted, ls] = await Promise.all([
      readFile(task.sourceFileId),
      readFile(task.adaptedFileId),
      readFile(task.lsFileId),
    ]);
    const result = await processTask(
      {
        showName: task.showName,
        sourceLanguage: task.sourceLanguage,
        adaptedLanguage: task.adaptedLanguage,
        taskId,
        provider: conf.provider,
        model: conf.model,
      },
      { source, adapted, ls },
      (system, user) => callModel(conf, system, user),
      async ({ done, total }) => {
        await col.updateOne({ taskId }, { $set: { progress: { done, total }, updatedAt: new Date() } });
      }
    );
    for (const ep of result.episodeResults) {
      await episodesCol().updateOne(
        { taskId, epNo: ep.epNo },
        { $set: { taskId, ...ep, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    if (!result.outputs) {
      await col.updateOne(
        { taskId },
        { $set: { status: "Failed", summary: result.summary, error: `Episodes failed validation: ${result.summary.episodesFailed.join(", ")}`, updatedAt: new Date() } }
      );
      return;
    }
    const safe = task.showName.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "Show";
    const [reviewFileId, correctedFileId, changelogFileId] = await Promise.all([
      saveFile(result.outputs.review, { filename: `${safe} - Review (highlighted, not applied).docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", metadata: { taskId, kind: "review" } }),
      saveFile(result.outputs.corrected, { filename: `${safe} - Corrected.docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", metadata: { taskId, kind: "corrected" } }),
      saveFile(result.outputs.log, { filename: `${safe} - Change log.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", metadata: { taskId, kind: "changelog" } }),
    ]);
    await col.updateOne(
      { taskId },
      { $set: { status: "Ready", summary: result.summary, reviewFileId, correctedFileId, changelogFileId, updatedAt: new Date() } }
    );
  } catch (e) {
    await col.updateOne({ taskId }, { $set: { status: "Failed", error: String(e.message || e), updatedAt: new Date() } });
  }
}

app.get("/api/health", (req, res) => {
  let model = null;
  try {
    const c = providerConfig();
    model = { provider: c.provider, model: c.model, keySet: Boolean(c.key) };
  } catch { /* reported below */ }
  res.json({ ok: true, dbConfigured: dbConfigured(), model });
});

app.post(
  "/api/tasks",
  upload.fields([
    { name: "sourceFile", maxCount: 1 },
    { name: "adaptedFile", maxCount: 1 },
    { name: "lsFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { showName, sourceLanguage, adaptedLanguage } = req.body;
      const src = req.files?.sourceFile?.[0];
      const adp = req.files?.adaptedFile?.[0];
      const ls = req.files?.lsFile?.[0];
      if (!showName || !sourceLanguage || !adaptedLanguage) return res.status(400).json({ error: "Show name and both languages are required" });
      if (!src || !adp || !ls) return res.status(400).json({ error: "All three files are required: source script (.docx), adapted script (.docx), LS sheet (.xlsx)" });
      const taskId = await nextTaskId();
      const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const [sourceFileId, adaptedFileId, lsFileId] = await Promise.all([
        saveFile(src.buffer, { filename: src.originalname, contentType: docxType, metadata: { taskId, kind: "source" } }),
        saveFile(adp.buffer, { filename: adp.originalname, contentType: docxType, metadata: { taskId, kind: "adapted" } }),
        saveFile(ls.buffer, { filename: ls.originalname, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", metadata: { taskId, kind: "ls" } }),
      ]);
      const task = {
        taskId,
        showName,
        sourceLanguage,
        adaptedLanguage,
        sourceFileName: src.originalname,
        adaptedFileName: adp.originalname,
        lsFileName: ls.originalname,
        sourceFileId, adaptedFileId, lsFileId,
        status: "Submitted",
        progress: null,
        summary: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await tasks().insertOne(task);
      res.json({ taskId, status: "Submitted" });
      runTask(taskId).catch((e) => console.error("runTask", taskId, e));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  }
);

app.get("/api/tasks", async (req, res) => {
  const list = await tasks().find({}).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(list.map(publicTask));
});

app.get("/api/tasks/:id", async (req, res) => {
  const t = await tasks().findOne({ taskId: req.params.id });
  if (!t) return res.status(404).json({ error: "Task not found" });
  res.json(publicTask(t));
});

app.post("/api/tasks/:id/reprocess", async (req, res) => {
  const t = await tasks().findOne({ taskId: req.params.id });
  if (!t) return res.status(404).json({ error: "Task not found" });
  if (t.status === "Processing") return res.status(409).json({ error: "Task is already processing" });
  await tasks().updateOne({ taskId: t.taskId }, { $set: { status: "Submitted", error: null } });
  res.json({ taskId: t.taskId, status: "Submitted" });
  runTask(t.taskId).catch((e) => console.error("runTask", t.taskId, e));
});

app.get("/api/tasks/:id/files/:kind", async (req, res) => {
  const spec = FILE_KINDS[req.params.kind];
  if (!spec) return res.status(404).json({ error: "Unknown file kind" });
  const t = await tasks().findOne({ taskId: req.params.id });
  if (!t || !t[spec.field]) return res.status(404).json({ error: "File not available" });
  const nameField = { sourceFileId: "sourceFileName", adaptedFileId: "adaptedFileName", lsFileId: "lsFileName" }[spec.field];
  const filename = t[nameField] || spec.fallback;
  const buf = await readFile(t[spec.field]);
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.setHeader("Content-Length", buf.length);
  res.end(buf);
});

const port = process.env.PORT || 3000;
if (dbConfigured()) {
  await connectDb();
  // Resume anything left mid-processing by a restart.
  const stuck = await tasks().find({ status: "Processing" }).toArray();
  for (const t of stuck) runTask(t.taskId).catch((e) => console.error("resume", t.taskId, e));
}
app.listen(port, () => {
  console.log(`Proofreader Tool listening on :${port} (db: ${dbConfigured() ? "configured" : "NOT configured — set MONGODB_URI"})`);
});
