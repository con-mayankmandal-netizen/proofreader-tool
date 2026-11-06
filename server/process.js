// Processing pipeline (PROMPT_PACK.md sections 1 and 5; SPEC.md):
// episodes in blocks of 5, one model call per episode, validation with up
// to 3 attempts, then a deterministic pass 2 over the "clean" lines, then
// the three outputs built from the validated results only.
//
// processTask is deliberately storage-free: it takes file buffers and a
// callLLM(system, user) function and returns results + output buffers, so
// it can be smoke-tested offline with a stubbed model.
import { readDocx } from "./docx.js";
import { splitEpisodes, episodeLines, sourceSentences, parseLS, lsSubset } from "./extract.js";
import { buildSystemPrompt, buildUserMessage, retrySuffix, PROMPT_VERSION } from "./prompt.js";
import { extractJson } from "./llm.js";
import { validateEpisodeResult } from "./validate.js";
import { buildReviewDocx, buildCorrectedDocx, buildChangeLogXlsx } from "./outputs.js";

export const BLOCK_SIZE = 5;
const MAX_ATTEMPTS = 3;

function recount(result) {
  const { coverage, fixes } = result;
  return {
    linesChecked: coverage.length,
    clean: coverage.filter((c) => c.status === "clean").length,
    fixesS: fixes.filter((f) => f.category === "S").length,
    fixesE: fixes.filter((f) => f.category === "E").length,
    applied: fixes.filter((f) => f.status === "Applied").length,
    appliedFlagged: fixes.filter((f) => f.status === "Applied (flagged)").length,
    flaggedOnly: fixes.filter((f) => f.status === "Flagged only").length,
    addRows: fixes.filter((f) => /-ADD-\d+$/.test(f.id)).length,
  };
}

// Pass 2 (deterministic): source-language names left standing in lines the
// model marked clean. Only fires when a concrete LS-backed replacement
// exists, and the result is always Flagged only — never applied.
function pass2NameLeaks(result, lines, entities) {
  const cleanIds = new Set(result.coverage.filter((c) => c.status === "clean").map((c) => c.line_id));
  const localisedForms = new Set();
  for (const e of entities) for (const m of e.mentions) localisedForms.add(m.localised_mention.toLowerCase());
  const added = [];
  for (const line of lines) {
    if (!cleanIds.has(line.line_id) || line.isTitle) continue;
    for (const e of entities) {
      let hit = null;
      for (const m of e.mentions) {
        const orig = m.original_mention;
        if (orig.length < 4) continue;
        if (orig.toLowerCase() === m.localised_mention.toLowerCase()) continue;
        if (localisedForms.has(orig.toLowerCase())) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
        if (re.test(line.text)) {
          hit = { orig, loc: m.localised_mention };
          break;
        }
      }
      if (hit) {
        const after = line.text.replace(hit.orig, hit.loc);
        if (after !== line.text) {
          added.push({
            id: line.line_id,
            ep: result.epNo,
            source: "(pass 2 deterministic check)",
            before: line.text,
            after,
            meaning_before: "The adapted line still uses the source-language name.",
            meaning_after: "Same meaning.",
            what_changed: `Source-language name "${hit.orig}" replaced with the LS localised name "${hit.loc}" (suggested).`,
            category: "E",
            subtype: "Terminology",
            why: `Pass 2: the source-language name "${hit.orig}" is still standing in the adapted text; the LS sheet localises it as "${hit.loc}". Flagged for a human because automated matching cannot judge inflected forms.`,
            confidence: "Low",
            status: "Flagged only",
            pass2: true,
          });
          const cov = result.coverage.find((c) => c.line_id === line.line_id);
          if (cov) cov.status = "flag";
          break;
        }
      }
    }
  }
  if (added.length) {
    result.fixes.push(...added);
    result.totals = recount(result);
    result.pass2Finds = added.length;
  }
  return added.length;
}

export async function processTask(meta, files, callLLM, onProgress = () => {}) {
  const adaptedParas = await readDocx(files.adapted);
  const sourceParas = await readDocx(files.source);
  const adaptedEps = splitEpisodes(adaptedParas);
  const sourceEps = splitEpisodes(sourceParas);
  if (!adaptedEps.length) throw new Error("No episodes found in the adapted script (no Heading paragraphs)");
  if (!sourceEps.length) throw new Error("No episodes found in the source script (no Heading paragraphs)");
  const entities = parseLS(files.ls);
  const warnings = [];
  if (adaptedEps.length !== sourceEps.length) {
    warnings.push(
      `Episode count differs (source ${sourceEps.length}, adapted ${adaptedEps.length}); episodes were aligned by order and only the first ${Math.min(adaptedEps.length, sourceEps.length)} were processed.`
    );
  }
  const n = Math.min(adaptedEps.length, sourceEps.length);
  const episodeResults = [];

  for (let blockStart = 0; blockStart < n; blockStart += BLOCK_SIZE) {
    const block = [];
    for (let i = blockStart; i < Math.min(blockStart + BLOCK_SIZE, n); i++) block.push(i);
    for (const idx of block) {
      const aEp = adaptedEps[idx];
      const sEp = sourceEps[idx];
      const lines = episodeLines(aEp);
      const srcSents = sourceSentences(sEp);
      const subset = lsSubset(entities, aEp.epNo).map((e) => ({
        original: e.original,
        localised: e.localised,
        gender: e.gender || "",
        mentions: e.mentions.map((m) => ({
          original_mention: m.original_mention,
          localised_mention: m.localised_mention,
          chapters: m.chapters || "",
        })),
      }));
      const system = buildSystemPrompt({
        sourceLanguage: meta.sourceLanguage,
        adaptedLanguage: meta.adaptedLanguage,
        showName: meta.showName,
        episodeNumber: aEp.epNo,
      });
      const baseUser = buildUserMessage({
        showName: meta.showName,
        episodeNumber: aEp.epNo,
        sourceLanguage: meta.sourceLanguage,
        adaptedLanguage: meta.adaptedLanguage,
        sourceTitle: sEp.title,
        adaptedTitle: aEp.title,
        lsData: subset,
        sourceSents: srcSents,
        lines,
      });
      let result = null;
      let lastErrors = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const user = attempt === 1 ? baseUser : baseUser + retrySuffix(lastErrors);
        const raw = await callLLM(system, user);
        let parsed;
        try {
          parsed = extractJson(raw);
        } catch (e) {
          lastErrors = [`output did not parse as JSON (${e.message})`];
          continue;
        }
        const v = validateEpisodeResult(parsed, { lines, adaptedLanguage: meta.adaptedLanguage, epNo: aEp.epNo });
        if (v.ok) {
          result = { epNo: aEp.epNo, coverage: parsed.coverage, fixes: parsed.fixes, totals: v.totals, status: "ok", attempts: attempt, pass2Finds: 0 };
          break;
        }
        lastErrors = v.errors;
      }
      if (!result) {
        episodeResults.push({ epNo: aEp.epNo, status: "failed", errors: lastErrors, totals: null, fixes: [], coverage: [] });
      } else {
        pass2NameLeaks(result, lines, entities);
        episodeResults.push(result);
      }
      onProgress({ done: episodeResults.length, total: n, epNo: aEp.epNo });
    }
  }

  const failed = episodeResults.filter((e) => e.status === "failed");
  const summary = {
    episodesProcessed: episodeResults.length,
    episodesFailed: failed.map((e) => e.epNo),
    totalFixes: episodeResults.reduce((a, e) => a + (e.fixes?.length || 0), 0),
    pass2Finds: episodeResults.reduce((a, e) => a + (e.pass2Finds || 0), 0),
    warnings,
    promptVersion: PROMPT_VERSION,
  };
  if (failed.length) return { episodeResults, summary, outputs: null };

  // Assemble the document model for the output builders.
  const linesByPara = new Map();
  const lineById = new Map();
  const fixesByLine = new Map();
  const addsByAnchor = new Map();
  const allFixes = [];
  adaptedEps.slice(0, n).forEach((aEp, idx) => {
    const lines = episodeLines(aEp);
    for (const l of lines) {
      lineById.set(l.line_id, l);
      if (!linesByPara.has(l.paraIdx)) linesByPara.set(l.paraIdx, []);
      linesByPara.get(l.paraIdx).push(l);
    }
    const res = episodeResults[idx];
    for (const f of res.fixes) {
      allFixes.push(f);
      if (/-ADD-\d+$/.test(f.id)) {
        if (!addsByAnchor.has(f.insert_after)) addsByAnchor.set(f.insert_after, []);
        addsByAnchor.get(f.insert_after).push(f);
      } else {
        fixesByLine.set(f.id, f);
      }
    }
  });
  const docModel = {
    paragraphs: adaptedParas.map((p, i) => ({ ...p, paraIdx: i })),
    linesByPara, lineById, fixesByLine, addsByAnchor,
  };
  const [review, corrected] = await Promise.all([buildReviewDocx(docModel), buildCorrectedDocx(docModel)]);
  const log = buildChangeLogXlsx({
    allFixes,
    episodeSummaries: episodeResults.map((e) => ({ epNo: e.epNo, totals: e.totals, status: e.status })),
    meta: { ...meta, promptVersion: PROMPT_VERSION },
  });
  return { episodeResults, summary, outputs: { review, corrected, log } };
}
