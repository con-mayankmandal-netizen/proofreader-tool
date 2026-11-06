// Extraction: .docx paragraphs -> episodes -> lines; .xlsx LS sheet -> entities.
import * as XLSX from "xlsx";

const HEADING_RE = /^heading\s*[1-6]$/i;

export function isHeading(style) {
  return HEADING_RE.test(String(style || ""));
}

// Split paragraphs into episodes at Heading paragraphs. Paragraphs before the
// first heading (e.g. a Title-style show title) are kept as front matter.
export function splitEpisodes(paragraphs) {
  const episodes = [];
  let current = null;
  paragraphs.forEach((p, idx) => {
    if (isHeading(p.style) && p.text.trim() !== "") {
      current = { titleParaIdx: idx, title: p.text, titleStyle: p.style, body: [] };
      episodes.push(current);
    } else if (current) {
      current.body.push({ paraIdx: idx, style: p.style, text: p.text });
    }
  });
  episodes.forEach((ep, i) => {
    ep.seq = i + 1;
    ep.epNo = parseEpisodeNo(ep.title) ?? ep.seq;
  });
  return episodes;
}

export function parseEpisodeNo(title) {
  const m = /(\d{1,4})/.exec(String(title || ""));
  return m ? parseInt(m[1], 10) : null;
}

// Sentence-split one paragraph's text, keeping exact char spans so the
// original paragraph can be rebuilt byte-for-byte from its lines.
// Rules: split after [.!?…] (+ closing quotes/brackets) followed by space or
// end; never split inside bracketed direction lines ([...] stays whole);
// "\n" (from <w:br/>) is always a boundary and is not part of any line.
export function splitSentences(text) {
  const out = [];
  const push = (s, e) => {
    const raw = text.slice(s, e);
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const lead = raw.length - raw.trimStart().length;
    out.push({ start: s + lead, end: s + lead + trimmed.length, text: trimmed });
  };
  let segStart = 0;
  const segments = [];
  let i = 0;
  while (i <= text.length) {
    if (i === text.length || text[i] === "\n") {
      segments.push([segStart, i]);
      segStart = i + 1;
    }
    i++;
  }
  for (const [ss, se] of segments) {
    const seg = text.slice(ss, se);
    if (seg.trim() === "") continue;
    if (seg.trimStart().startsWith("[")) {
      push(ss, se);
      continue;
    }
    let start = 0;
    const re = /[.!?…]+["”’'»)\]]*\s+/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      const cut = m.index + m[0].length;
      push(ss + start, ss + cut);
      start = cut;
    }
    push(ss + start, se);
  }
  return out;
}

// Build the line list for one episode: the title line first (id E{ep}-T),
// then one line per sentence, ids E{ep}-001 ... in document order.
export function episodeLines(ep) {
  const lines = [
    {
      line_id: `E${ep.epNo}-T`,
      paraIdx: ep.titleParaIdx,
      style: ep.titleStyle,
      start: 0,
      end: ep.title.length,
      text: ep.title,
      isTitle: true,
    },
  ];
  let n = 0;
  for (const p of ep.body) {
    for (const s of splitSentences(p.text)) {
      n += 1;
      lines.push({
        line_id: `E${ep.epNo}-${String(n).padStart(3, "0")}`,
        paraIdx: p.paraIdx,
        style: p.style,
        start: s.start,
        end: s.end,
        text: s.text,
        isTitle: false,
      });
    }
  }
  return lines;
}

// Source side: numbered sentences for the prompt payload.
export function sourceSentences(ep) {
  const out = [];
  for (const p of ep.body) {
    for (const s of splitSentences(p.text)) out.push(s.text);
  }
  return out;
}

// ---- LS sheet ------------------------------------------------------------
// Reads every sheet; a row becomes a mention when it has both an original and
// a localised name. Mentions are grouped by ID (or by original_name when no
// ID column exists) into entities.
export function parseLS(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const byKey = new Map();
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
    for (const row of rows) {
      const g = (re) => {
        for (const k of Object.keys(row)) {
          if (re.test(k) && row[k] !== null && String(row[k]).trim() !== "") return String(row[k]).trim();
        }
        return "";
      };
      const original = g(/^original_name$/i) || g(/original.*mention/i);
      const localised = g(/^localised_name$/i) || g(/^localized_name$/i) || g(/localised.*mention/i);
      if (!original || !localised) continue;
      const id = g(/^id$/i);
      const key = id || original.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: id || key,
          type: g(/^type$/i),
          gender: "",
          original,
          localised,
          mentions: [],
        });
      }
      const ent = byKey.get(key);
      const gender = g(/^gender$/i);
      if (gender && !ent.gender) ent.gender = gender;
      const chRaw = g(/chapter/i);
      const chapters = chRaw ? [...chRaw.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10)) : [];
      const enMention = g(/english translated mention/i) || g(/english translated name/i);
      const mention = { original_mention: original, localised_mention: localised, chapters: chRaw };
      if (enMention) mention.english = enMention;
      if (!ent.mentions.some((x) => x.original_mention === original && x.localised_mention === localised)) {
        ent.mentions.push(mention);
      }
      if (chapters.length) {
        ent._chapters = ent._chapters || new Set();
        chapters.forEach((c) => ent._chapters.add(c));
      }
    }
  }
  const entities = [...byKey.values()].map((e) => {
    if (e._chapters) {
      e.chaptersCovered = [...e._chapters].sort((a, b) => a - b);
      delete e._chapters;
    }
    return e;
  });
  return entities;
}

// Episode subset: entities whose chapter coverage includes this episode, plus
// entities with no chapter information at all (whole-show). Capped so the
// payload stays lean; characters are kept first.
export function lsSubset(entities, epNo, cap = 150) {
  const inScope = entities.filter(
    (e) => !e.chaptersCovered || e.chaptersCovered.length === 0 || e.chaptersCovered.includes(epNo)
  );
  if (inScope.length <= cap) return inScope;
  const chars = inScope.filter((e) => /character/i.test(e.type || ""));
  const rest = inScope.filter((e) => !/character/i.test(e.type || ""));
  const scoped = rest.filter((e) => e.chaptersCovered && e.chaptersCovered.includes(epNo));
  return [...chars, ...scoped, ...rest].slice(0, cap);
}

export function numbersIn(text) {
  return [...String(text).matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0]);
}
