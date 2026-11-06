// The three outputs, built ONLY from validated episode results
// (PROMPT_PACK.md section 5, check 8 — never from a second model output).
import * as XLSX from "xlsx";
import { buildDocx } from "./docx.js";
import { appliedTexts } from "./validate.js";

// Char span of the changed words inside `before`, by token diffing
// before -> after. Falls back to the whole line.
export function diffSpan(before, after) {
  const words = (t) => {
    const out = [];
    for (const m of String(t).matchAll(/\S+/g)) out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  };
  const a = words(before);
  const b = words(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p].w === b[p].w) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s].w === b[b.length - 1 - s].w) s++;
  if (p >= a.length) return { start: 0, end: before.length };
  return { start: a[p].start, end: a[a.length - 1 - s].end };
}

function commentText(fix) {
  const lines = [
    `${fix.id} · ${fix.category} — ${fix.subtype} · ${fix.status} (${fix.confidence} confidence)`,
    `Why: ${fix.why}`,
    `What changed: ${fix.what_changed}`,
  ];
  if (fix.status === "Flagged only") lines.push(`Suggested correction (not applied): ${fix.after}`);
  else lines.push(`Correction: ${fix.after}`);
  if (fix.source) lines.push(`Source: ${fix.source}`);
  return lines.join("\n");
}

// doc: { paragraphs, fixesByLine, linesByPara, addsByAnchor }
export async function buildReviewDocx(doc) {
  const comments = [];
  let nextComment = 1;
  const outParas = [];
  doc.paragraphs.forEach((para, paraPos) => {
    const paraIdx = para.paraIdx ?? paraPos;
    const lines = (doc.linesByPara.get(paraIdx) || []).slice().sort((a, b) => a.start - b.start);
    if (!lines.length) {
      outParas.push({ style: para.style, runs: [{ text: para.text }] });
      return;
    }
    const runs = [];
    let cursor = 0;
    const plain = (from, to) => {
      if (to > from) runs.push({ text: para.text.slice(from, to) });
    };
    for (const line of lines) {
      plain(cursor, line.start);
      const fix = doc.fixesByLine.get(line.line_id);
      if (!fix) {
        plain(line.start, line.end);
      } else {
        const span = diffSpan(fix.before, fix.after);
        const hs = line.start + span.start;
        const he = line.start + span.end;
        plain(line.start, hs);
        const cid = nextComment++;
        comments.push({ id: cid, text: commentText(fix) });
        runs.push({
          text: para.text.slice(hs, he),
          highlight: fix.category === "S" ? "yellow" : "red",
          commentId: cid,
        });
        plain(he, line.end);
        // ADD rows anchored on this line ride along in its comment when the
        // line already has one, or get their own comment on the line's tail.
        const adds = doc.addsByAnchor.get(line.line_id) || [];
        for (const add of adds) {
          const c = comments.find((x) => x.id === cid);
          c.text += `\n\nMISSING LINE after this one (${add.id}): the source has a sentence the adapted script dropped.\nSuggested insertion (not in this document): ${add.after}\nWhy: ${add.why}`;
        }
      }
      cursor = line.end;
    }
    plain(cursor, para.text.length);
    // ADD rows anchored on a line with no fix of its own
    for (const line of lines) {
      if (doc.fixesByLine.has(line.line_id)) continue;
      const adds = doc.addsByAnchor.get(line.line_id) || [];
      for (const add of adds) {
        const cid = nextComment++;
        comments.push({
          id: cid,
          text:
            `${add.id} · S — Omission of source content · ${add.status} (${add.confidence} confidence)\n` +
            `Why: ${add.why}\nMissing line (not in this document): ${add.after}\nSource: ${add.source}`,
        });
        // anchor the comment on the last run of this line's text
        const r = [...runs].reverse().find((x) => x.text && x.text.trim() !== "");
        if (r && r.commentId === undefined) r.commentId = cid;
      }
    }
    outParas.push({ style: para.style, runs });
  });
  return buildDocx({ paragraphs: outParas, comments });
}

export async function buildCorrectedDocx(doc) {
  const applied = new Map();
  for (const [lid, fix] of doc.fixesByLine) {
    if (fix.status === "Applied" || fix.status === "Applied (flagged)") applied.set(lid, fix.after);
  }
  const appliedAdds = new Map();
  for (const [anchor, adds] of doc.addsByAnchor) {
    const ok = adds.filter((a) => a.status === "Applied" || a.status === "Applied (flagged)");
    if (ok.length) appliedAdds.set(anchor, ok);
  }
  const anchorPara = new Map(); // paraIdx -> [inserted texts]
  for (const [anchorId, adds] of appliedAdds) {
    const line = doc.lineById.get(anchorId);
    if (!line) continue;
    if (!anchorPara.has(line.paraIdx)) anchorPara.set(line.paraIdx, []);
    anchorPara.get(line.paraIdx).push(...adds.map((a) => a.after));
  }
  const outParas = [];
  doc.paragraphs.forEach((para, paraPos) => {
    const paraIdx = para.paraIdx ?? paraPos;
    const lines = (doc.linesByPara.get(paraIdx) || []).slice().sort((a, b) => b.start - a.start);
    let text = para.text;
    for (const line of lines) {
      if (applied.has(line.line_id)) {
        text = text.slice(0, line.start) + applied.get(line.line_id) + text.slice(line.end);
      }
    }
    outParas.push({ style: para.style, runs: [{ text }] });
    for (const ins of anchorPara.get(paraIdx) || []) {
      outParas.push({ style: "Normal", runs: [{ text: ins }] });
    }
  });
  return buildDocx({ paragraphs: outParas, comments: [] });
}

const LOG_COLUMNS = [
  "ID", "Episode", "Source line", "Before", "After", "Meaning of Before",
  "Meaning of After", "What changed", "Category", "Sub-type", "Why",
  "Confidence", "Status",
];

function logRow(f) {
  return [
    f.id, f.ep, f.source || "", f.before || "", f.after || "",
    f.meaning_before || "", f.meaning_after || "", f.what_changed || "",
    f.category, f.subtype, f.why || "", f.confidence, f.status,
  ];
}

export function buildChangeLogXlsx({ allFixes, episodeSummaries, meta }) {
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  };
  add("Change Log", [LOG_COLUMNS, ...allFixes.map(logRow)]);
  const sum = [
    ["Show", meta.showName],
    ["Source language", meta.sourceLanguage],
    ["Adapted language", meta.adaptedLanguage],
    ["Task ID", meta.taskId],
    ["Model", `${meta.provider} / ${meta.model}`],
    ["Prompt version", meta.promptVersion],
    [],
    ["Total lines checked", episodeSummaries.reduce((a, e) => a + (e.totals?.linesChecked || 0), 0)],
    ["Clean lines", episodeSummaries.reduce((a, e) => a + (e.totals?.clean || 0), 0)],
    ["S fixes", allFixes.filter((f) => f.category === "S").length],
    ["E fixes", allFixes.filter((f) => f.category === "E").length],
    ["Applied", allFixes.filter((f) => f.status === "Applied").length],
    ["Applied (flagged)", allFixes.filter((f) => f.status === "Applied (flagged)").length],
    ["Flagged only", allFixes.filter((f) => f.status === "Flagged only").length],
    ["Pass-2 finds (deterministic)", allFixes.filter((f) => f.pass2).length],
    [],
    ["Episode", "Lines checked", "Clean", "S", "E", "Applied", "Applied (flagged)", "Flagged only", "Status"],
    ...episodeSummaries.map((e) => [
      e.epNo, e.totals?.linesChecked ?? "", e.totals?.clean ?? "",
      e.totals?.fixesS ?? "", e.totals?.fixesE ?? "", e.totals?.applied ?? "",
      e.totals?.appliedFlagged ?? "", e.totals?.flaggedOnly ?? "", e.status,
    ]),
  ];
  add("Summary", sum);
  add("Needs Human Decision", [
    ["ID", "Episode", "Line (Before)", "Suggested fix", "Why", "Confidence"],
    ...allFixes
      .filter((f) => f.status === "Flagged only")
      .map((f) => [f.id, f.ep, f.before || "(missing line)", f.after, f.why || "", f.confidence]),
  ]);
  add("Semantic Fixes", [LOG_COLUMNS, ...allFixes.filter((f) => f.category === "S").map(logRow)]);
  add("Error Fixes", [LOG_COLUMNS, ...allFixes.filter((f) => f.category === "E").map(logRow)]);
  add("Name & Mention Fixes", [LOG_COLUMNS, ...allFixes.filter((f) => f.subtype === "Terminology").map(logRow)]);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
