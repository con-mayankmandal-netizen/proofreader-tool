// Minimal .docx read/write built on JSZip.
//
// readDocx:  buffer -> [{ style, text }] paragraphs (style = Word style NAME,
//            e.g. "Heading 1", "Normal"; text has <w:br/> as "\n").
// buildDocx: paragraphs of runs -> a complete .docx buffer.
//            A paragraph is { style, runs: [{ text, highlight, commentId }] }.
//            highlight: "red" | "yellow" | null. Lines of a run's text split
//            on "\n" become <w:br/> breaks. commentId wraps the run in a Word
//            comment range; the comment bodies come from `comments`:
//            [{ id, text }] (text may contain "\n" -> separate paragraphs).
import JSZip from "jszip";

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function deEsc(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function readDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx (word/document.xml missing)");
  const xml = await docFile.async("string");

  // styleId -> style name from word/styles.xml (fall back to the raw id)
  const nameById = {};
  const stylesFile = zip.file("word/styles.xml");
  if (stylesFile) {
    const sxml = await stylesFile.async("string");
    for (const m of sxml.matchAll(/<w:style [^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
      const nm = /<w:name w:val="([^"]+)"/.exec(m[2]);
      if (nm) nameById[m[1]] = nm[1];
    }
  }

  const paragraphs = [];
  for (const pm of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g)) {
    const body = pm[1] || "";
    const styleM = /<w:pStyle w:val="([^"]+)"/.exec(body);
    const styleId = styleM ? styleM[1] : "Normal";
    let text = "";
    // walk runs in order, collecting text and breaks
    for (const tok of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br(?:\s[^>]*)?\/?>|<w:tab(?:\s[^>]*)?\/?>/g)) {
      if (tok[1] !== undefined) text += deEsc(tok[1]);
      else if (tok[0].startsWith("<w:br")) text += "\n";
      else text += "\t";
    }
    paragraphs.push({ style: nameById[styleId] || styleId, text });
  }
  return paragraphs;
}

const STYLE_DEFS = [
  ["Normal", "Normal", null],
  ["Title", "Title", 0],
  ["Heading1", "heading 1", 0],
  ["Heading2", "heading 2", 1],
  ["Heading3", "heading 3", 2],
  ["Heading4", "heading 4", 3],
  ["Heading5", "heading 5", 4],
  ["Heading6", "heading 6", 5],
];

export function styleIdFromName(name) {
  if (!name) return "Normal";
  const n = String(name).toLowerCase().replace(/\s+/g, "");
  if (n === "normal") return "Normal";
  if (n === "title") return "Title";
  const h = /^heading([1-6])$/.exec(n);
  if (h) return "Heading" + h[1];
  return "Normal";
}

function runXml(run) {
  const parts = String(run.text).split("\n");
  const inner = parts
    .map((seg, i) => {
      const t = seg === "" ? "" : `<w:t xml:space="preserve">${esc(seg)}</w:t>`;
      return (i > 0 ? "<w:br/>" : "") + t;
    })
    .join("");
  const rpr = run.highlight ? `<w:rPr><w:highlight w:val="${run.highlight}"/></w:rPr>` : "";
  return `<w:r>${rpr}${inner}</w:r>`;
}

export async function buildDocx({ paragraphs, comments = [] }) {
  const hasComments = comments.length > 0;
  const body = paragraphs
    .map((p) => {
      const runs = (p.runs || [{ text: p.text || "" }])
        .map((r) => {
          const rx = runXml(r);
          if (r.commentId === undefined || r.commentId === null) return rx;
          return (
            `<w:commentRangeStart w:id="${r.commentId}"/>` +
            rx +
            `<w:commentRangeEnd w:id="${r.commentId}"/>` +
            `<w:r><w:commentReference w:id="${r.commentId}"/></w:r>`
          );
        })
        .join("");
      return `<w:p><w:pPr><w:pStyle w:val="${styleIdFromName(p.style)}"/></w:pPr>${runs}</w:p>`;
    })
    .join("");

  const styles = STYLE_DEFS.map(([id, name, outline]) => {
    const base =
      id === "Normal"
        ? `<w:rPr><w:sz w:val="22"/></w:rPr>`
        : `<w:rPr><w:b/><w:sz w:val="${id === "Title" ? 40 : 30}"/></w:rPr>`;
    const out = outline === null ? "" : `<w:pPr><w:outlineLvl w:val="${outline}"/></w:pPr>`;
    return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${out}${base}</w:style>`;
  }).join("");

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/></w:sectPr></w:body></w:document>`;

  const commentsXml = hasComments
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      comments
        .map(
          (c) =>
            `<w:comment w:id="${c.id}" w:author="Proofreader" w:date="2026-01-01T00:00:00Z">` +
            String(c.text)
              .split("\n")
              .map((line) => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`)
              .join("") +
            `</w:comment>`
        )
        .join("") +
      `</w:comments>`
    : null;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    (hasComments
      ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`
      : "") +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    (hasComments
      ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`
      : "") +
    `</Relationships>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.folder("_rels").file(".rels", rels);
  const word = zip.folder("word");
  word.file("document.xml", documentXml);
  word.file("styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`);
  word.folder("_rels").file("document.xml.rels", docRels);
  if (hasComments) word.file("comments.xml", commentsXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
