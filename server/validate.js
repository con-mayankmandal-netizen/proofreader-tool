// Server-side validation — PROMPT_PACK.md section 5. The prompt asks; this
// layer enforces. Any failure is returned as an error list for the retry
// loop; after the final attempt the episode is marked failed.
import { S_SUBTYPES, eSubtypes } from "./prompt.js";

const STATUS_FOR_CONFIDENCE = {
  High: "Applied",
  Medium: "Applied (flagged)",
  Low: "Flagged only",
};

// Out of scope — punctuation (product decision 2026-11-06): punctuation fixes
// are never proofread by this tool. A model that returns one anyway must not
// fail the whole episode for it (owner instruction 2026-11-06): the row is
// DROPPED before the strict checks run, never applied, and the drop is
// reported back so the caller can surface it in the task summary. Only the
// sub-type decides — a punctuation label is out of scope whatever category
// the model put it in. Everything else stays strict (byte-exact before etc.).
const PUNCT_SUBTYPE_EXACT = new Set([
  "comma", "commas", "comma use", "quotation marks", "quote style",
  "apostrophe", "apostrophes", "dash", "dashes", "hyphen", "hyphens",
  "period", "periods", "full stop", "full stops", "question marks",
  "exclamation marks", "colon", "colons", "semicolon", "semicolons",
  "brackets", "ellipsis",
]);

export function isOutOfScopeFix(f) {
  if (!f || typeof f.subtype !== "string") return false;
  const st = f.subtype.trim();
  return /punct/i.test(st) || PUNCT_SUBTYPE_EXACT.has(st.toLowerCase());
}

export function validateEpisodeResult(result, { lines, adaptedLanguage, epNo }) {
  const errors = [];
  if (!result || typeof result !== "object") return { ok: false, errors: ["output is not a JSON object"], totals: null, dropped: [] };
  const keys = Object.keys(result).sort();
  if (keys.join(",") !== "coverage,fixes") {
    errors.push(`top-level keys must be exactly "coverage" and "fixes" (got: ${keys.join(", ") || "none"})`);
    return { ok: false, errors, totals: null, dropped: [] };
  }
  const { coverage, fixes } = result;
  const lineById = new Map(lines.map((l) => [l.line_id, l]));

  if (!Array.isArray(fixes)) {
    errors.push("fixes must be an array");
    return { ok: false, errors, totals: null, dropped: [] };
  }

  // Out-of-scope drop: remove punctuation fix rows BEFORE the strict checks.
  // A line whose only fix rows were dropped falls back to "clean" in
  // coverage; ADD rows are never dropped (their sub-type is fixed by the
  // contract and is never a punctuation label).
  const dropped = [];
  const keptFixes = [];
  for (const f of fixes) {
    if (f && !/-ADD-\d+$/.test(f.id || "") && isOutOfScopeFix(f)) {
      dropped.push({ id: f.id || "(missing id)", subtype: f.subtype });
    } else {
      keptFixes.push(f);
    }
  }
  if (dropped.length && Array.isArray(coverage)) {
    const keptIds = new Set(keptFixes.map((f) => f.id));
    for (const c of coverage) {
      if ((c.status === "fix" || c.status === "flag") && !keptIds.has(c.line_id)) c.status = "clean";
    }
  }

  // Check 2: coverage shape
  if (!Array.isArray(coverage) || coverage.length !== lines.length) {
    errors.push(`coverage must list every adapted line exactly once (${lines.length} entries incl. title); got ${Array.isArray(coverage) ? coverage.length : "non-array"}`);
  } else {
    coverage.forEach((c, i) => {
      if (c.line_id !== lines[i].line_id) {
        errors.push(`coverage entry ${i + 1} should be ${lines[i].line_id}, got ${c.line_id}`);
      }
      if (!["clean", "fix", "flag"].includes(c.status)) {
        errors.push(`coverage status of ${c.line_id} must be clean|fix|flag, got "${c.status}"`);
      }
    });
  }
  const covStatus = new Map((Array.isArray(coverage) ? coverage : []).map((c) => [c.line_id, c.status]));

  const allowedS = new Set(S_SUBTYPES);
  const allowedE = new Set(eSubtypes(adaptedLanguage));
  const seenIds = new Set();
  let addSeq = 0;

  for (const f of keptFixes) {
    const id = f.id || "(missing id)";
    if (seenIds.has(id)) errors.push(`duplicate fix row for ${id}`);
    seenIds.add(id);
    const isAdd = /-ADD-\d+$/.test(id);

    if (isAdd) {
      addSeq += 1;
      if (id !== `E${epNo}-ADD-${addSeq}`) errors.push(`ADD rows must be sequential: expected E${epNo}-ADD-${addSeq}, got ${id}`);
      if (covStatus.has(id)) errors.push(`ADD row ${id} must NOT appear in coverage`);
      if (!f.insert_after || !lineById.has(f.insert_after)) errors.push(`ADD row ${id} has invalid insert_after "${f.insert_after}"`);
      if (f.before !== "") errors.push(`ADD row ${id}: before must be ""`);
      if (f.category !== "S" || f.subtype !== "Omission of source content") {
        errors.push(`ADD row ${id} must be category S, subtype "Omission of source content"`);
      }
    } else {
      if (!lineById.has(id)) {
        errors.push(`fix row id ${id} is not one of this episode's line ids`);
        continue;
      }
      // Check 4: byte-exact before
      if (f.before !== lineById.get(id).text) {
        errors.push(`"before" of ${id} does not match the input line byte for byte`);
      }
      // Check 3: coverage status agreement
      const want = f.status === "Flagged only" ? "flag" : "fix";
      if (covStatus.get(id) !== want) {
        errors.push(`coverage status of ${id} should be "${want}" for a fix with status "${f.status}", got "${covStatus.get(id)}"`);
      }
    }
    // Check 5: after differs from before
    if (typeof f.after !== "string" || f.after === "" || f.after === f.before) {
      errors.push(`fix ${id}: "after" must be a non-empty line different from "before"`);
    }
    // Check 6: category / subtype / confidence pairing
    if (!["S", "E"].includes(f.category)) errors.push(`fix ${id}: category must be S or E`);
    const allowed = f.category === "S" ? allowedS : allowedE;
    if (!allowed.has(f.subtype)) errors.push(`fix ${id}: subtype "${f.subtype}" is not an allowed ${f.category} sub-type`);
    if (!STATUS_FOR_CONFIDENCE[f.confidence]) errors.push(`fix ${id}: confidence must be High, Medium or Low`);
    else if (STATUS_FOR_CONFIDENCE[f.confidence] !== f.status) {
      errors.push(`fix ${id}: confidence ${f.confidence} requires status "${STATUS_FOR_CONFIDENCE[f.confidence]}", got "${f.status}"`);
    }
    if (f.ep !== undefined && f.ep !== epNo) errors.push(`fix ${id}: ep field is ${f.ep}, expected ${epNo}`);
  }

  // Check 3 (reverse): every coverage fix/flag entry has a fix row
  for (const [lid, st] of covStatus) {
    if ((st === "fix" || st === "flag") && !seenIds.has(lid)) {
      errors.push(`coverage marks ${lid} as "${st}" but there is no fix row for it`);
    }
    if (st === "clean" && seenIds.has(lid)) {
      errors.push(`coverage marks ${lid} clean but a fix row exists for it`);
    }
  }

  if (errors.length) return { ok: false, errors, totals: null, dropped };

  // Check 7: totals (kept fixes only — dropped rows never happened)
  const totals = {
    linesChecked: lines.length,
    clean: coverage.filter((c) => c.status === "clean").length,
    fixesS: keptFixes.filter((f) => f.category === "S").length,
    fixesE: keptFixes.filter((f) => f.category === "E").length,
    applied: keptFixes.filter((f) => f.status === "Applied").length,
    appliedFlagged: keptFixes.filter((f) => f.status === "Applied (flagged)").length,
    flaggedOnly: keptFixes.filter((f) => f.status === "Flagged only").length,
    addRows: keptFixes.filter((f) => /-ADD-\d+$/.test(f.id)).length,
  };
  return { ok: true, errors: [], totals, fixes: keptFixes, coverage, dropped };
}

// Apply the validated fixes to the episode's lines (check 8 helper):
// returns a Map line_id -> corrected text for Applied + Applied (flagged).
export function appliedTexts(fixes) {
  const map = new Map();
  for (const f of fixes) {
    if (/-ADD-\d+$/.test(f.id)) continue;
    if (f.status === "Applied" || f.status === "Applied (flagged)") map.set(f.id, f.after);
  }
  return map;
}
