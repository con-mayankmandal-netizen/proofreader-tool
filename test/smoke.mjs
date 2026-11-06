// Offline smoke test — no API key, no MongoDB needed.
//   node test/smoke.mjs [source.docx] [adapted.docx] [ls.xlsx]
// Defaults point at the MVS German->Turkish pilot fixtures if present.
// The model is stubbed: episode 105 replays the pilot's real, verified
// fixes.json (when it validates against this extractor's lines); every
// other episode gets synthetic fixes built from the payload's own lines.
import fs from "node:fs";
import path from "node:path";
import { readDocx } from "../server/docx.js";
import { splitEpisodes, episodeLines } from "../server/extract.js";
import { validateEpisodeResult } from "../server/validate.js";
import { processTask } from "../server/process.js";

const HOME = process.env.HOME;
const [srcPath, adpPath, lsPath] = [
  process.argv[2] || `${HOME}/workspace/user/files/Source_script.docx`,
  process.argv[3] || `${HOME}/workspace/user/files/Adapted_script.docx`,
  process.argv[4] || `${HOME}/workspace/user/files/MVS_Turkey_Ep_101_-_200_Vetted_LS.xlsx`,
];
const GOLDEN = `${HOME}/workspace/pr-proofreader/pilot/ep105/fixes.json`;
const OUT = "/tmp/smoke-out";

for (const p of [srcPath, adpPath, lsPath]) {
  if (!fs.existsSync(p)) {
    console.log(`SKIP: fixture not found: ${p}`);
    process.exit(0);
  }
}
const files = {
  source: fs.readFileSync(srcPath),
  adapted: fs.readFileSync(adpPath),
  ls: fs.readFileSync(lsPath),
};

// 1) Extraction sanity
const adpParas = await readDocx(files.adapted);
const eps = splitEpisodes(adpParas);
console.log(`adapted episodes: ${eps.length}`);
let goldenOk = false;
for (const ep of eps) {
  const lines = episodeLines(ep);
  console.log(`  E${ep.epNo}: ${lines.length} lines (incl. title)`);
  if (ep.epNo === 105 && fs.existsSync(GOLDEN)) {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    const v = validateEpisodeResult(golden, { lines, adaptedLanguage: "Turkish", epNo: 105 });
    goldenOk = v.ok;
    console.log(`  golden ep105 validation: ${v.ok ? "OK" : "FAILED — " + v.errors.slice(0, 3).join(" | ")}`);
  }
}

// 2) Stubbed model
function stubResult(user) {
  const epNo = parseInt(/EPISODE: (\d+)/.exec(user)[1], 10);
  if (epNo === 105 && goldenOk) return fs.readFileSync(GOLDEN, "utf8");
  const linesJson = JSON.parse(/ADAPTED LINES \(JSON array[^)]*\):\n(\[.*\])\n\nOUTPUT CONTRACT/s.exec(user)[1]);
  const coverage = linesJson.map((l) => ({ line_id: l.line_id, status: "clean" }));
  const fixes = [];
  const pick = (idx, make) => {
    const l = linesJson[idx];
    if (!l || l.text.length < 8) return;
    const f = make(l);
    if (f) {
      coverage[idx].status = f.status === "Flagged only" ? "flag" : "fix";
      fixes.push(f);
    }
  };
  pick(3, (l) => {
    const w = /^(\S+)/.exec(l.text)[1];
    const flipped = w[0] === w[0].toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1);
    const after = flipped + l.text.slice(w.length);
    if (after === l.text) return null;
    return { id: l.line_id, ep: epNo, source: "(stub)", before: l.text, after, meaning_before: "stub", meaning_after: "Same meaning.", what_changed: "Stub edit: first letter case.", category: "E", subtype: "Grammar / syntax", why: "Stub fix for pipeline testing.", confidence: "High", status: "Applied" };
  });
  pick(6, (l) => ({
    id: l.line_id, ep: epNo, source: "(stub)", before: l.text, after: l.text + " (stub)",
    meaning_before: "stub", meaning_after: "stub", what_changed: "Stub semantic flag.", category: "S",
    subtype: "Meaning changed (fact/action)", why: "Stub flagged row for pipeline testing.", confidence: "Low", status: "Flagged only",
  }));
  const anchor = linesJson[4];
  if (anchor) {
    fixes.push({
      id: `E${epNo}-ADD-1`, ep: epNo, insert_after: anchor.line_id, source: "(stub source sentence)",
      before: "", after: "Stub inserted line (dropped source sentence).", meaning_before: "",
      meaning_after: "Stub insertion.", what_changed: "Inserted a dropped source sentence.",
      category: "S", subtype: "Omission of source content", why: "Stub ADD row for pipeline testing.",
      confidence: "Medium", status: "Applied (flagged)",
    });
  }
  return JSON.stringify({ coverage, fixes });
}

// 3) Full pipeline
const result = await processTask(
  { showName: "Smoke Test Show", sourceLanguage: "German", adaptedLanguage: "Turkish", taskId: "PR-TEST", provider: "stub", model: "stub" },
  files,
  async (system, user) => stubResult(user),
  () => {}
);
console.log("summary:", JSON.stringify(result.summary));
if (!result.outputs) {
  console.log("FAILED episodes:", result.episodeResults.filter((e) => e.status === "failed").map((e) => ({ ep: e.epNo, errors: e.errors?.slice(0, 2) })));
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "review.docx"), result.outputs.review);
fs.writeFileSync(path.join(OUT, "corrected.docx"), result.outputs.corrected);
fs.writeFileSync(path.join(OUT, "changelog.xlsx"), result.outputs.log);
console.log(`outputs written to ${OUT}: review ${result.outputs.review.length}B, corrected ${result.outputs.corrected.length}B, log ${result.outputs.log.length}B`);
