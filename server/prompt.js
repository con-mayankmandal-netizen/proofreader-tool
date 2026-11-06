// Prompt assembly — the master system prompt is the verbatim text of
// PROMPT_PACK.md section 2, with {{...}} placeholders filled per job.
// PROMPT_VERSION is stored with every result; bump it when the prompt text
// below changes, so old and new results are never confused.
export const PROMPT_VERSION = "1.0";

export const LANGUAGES = [
  "English", "German", "Turkish", "Polish", "Spanish", "French",
  "Italian", "Portuguese", "Dutch", "Hindi", "Russian", "Arabic",
];

const TURKISH_PROFILE = `LANGUAGE PROFILE — TURKISH (adapted):
- Spelling standard is TDK. Watch for missing or wrong circumflex-free spellings and
  apostrophe use with proper names (Arda'ya, "to Arda").
- Case and possessive suffixes on names are grammar, not different mentions: a listed name
  with a Turkish suffix chain is the same mention.
- Vowel harmony violations in suffixes are E / Grammar / syntax.
- Dialogue in quotes (straight or curly) is the convention; speech not marked as speech at
  all = E / Labelling. Punctuation and quote style are out of scope — never flag them.
- Word order copied from German (verb pushed unnaturally, genitive chains mirroring German)
  that a native reader spots as translated = E / Source-shaped (calque).`;

const POLISH_PROFILE = `LANGUAGE PROFILE — POLISH (adapted):
- Gender endings: Polish past-tense verbs and adjectives show the SUBJECT's gender
  (-łem/-łam "I did", powiedział/powiedziała "he/she said"). In an audio script the listener
  hears the speaker's gender from these endings. A first-person or narrated ending that
  contradicts the speaker's gender in the LS data = E / Gender ending (Polish). Check every
  first-person past-tense line against who is speaking.
- Formality: Pan/Pani (capitalised in direct address) is formal; ty is informal. Students
  among themselves use ty; the source's "sir/ma'am" or a formal address rendered as ty
  (or the reverse) = E / Register / speech level.
- Punctuation is OUT OF SCOPE (product decision, 2026-11-06): never flag or fix commas or
  any other punctuation-only issue. Polish comma rules (required before że/który/gdy...,
  none before i/oraz...) are therefore NOT checked. Missing diacritics are spelling, not
  punctuation — still E / Spelling.
- Dialogue convention is Polish quotes „...”. Keep it. Speech not marked as speech at
  all = E / Labelling. Do NOT convert quotes to dashes.
- Declension is not an error: Polish names decline (Kacper -> Kacpra, Kacprowi, vocative
  Kacprze!). Inflected forms of an LS name are correct. A name in the wrong base form where
  grammar needs an inflected one (or vice versa), or one name spelled two ways, = E.
- Family-name number: a surname may have listed singular/plural forms (one man vs the
  family); the sheet lists both — number in context decides, not consistency.
- House format: the heading label "Chapter" in adapted episode titles is the file's own
  format — do not flag it; judge only the title's meaning against the source title.`;

const PROFILES = {
  Turkish: {
    spelling: "TDK standard",
    spellingShort: "TDK",
    extraESubtypes: [],
    profile: TURKISH_PROFILE,
  },
  Polish: {
    spelling: "Polish orthography, including diacritics ą ć ę ł ń ó ś ź ż",
    spellingShort: "Polish orthography",
    extraESubtypes: ["Gender ending (Polish)"],
    profile: POLISH_PROFILE,
  },
};

export function profileFor(adaptedLanguage) {
  if (PROFILES[adaptedLanguage]) return PROFILES[adaptedLanguage];
  return {
    spelling: `the standard orthography of ${adaptedLanguage}`,
    spellingShort: `${adaptedLanguage} orthography`,
    extraESubtypes: [],
    profile:
      `LANGUAGE PROFILE — ${adaptedLanguage.toUpperCase()} (adapted):\n` +
      `- No language-specific profile has been written for ${adaptedLanguage} yet; apply the ` +
      `general rules above, the LS data, and the standard orthography of ${adaptedLanguage}. ` +
      `Punctuation is out of scope — never flag it.`,
  };
}

export const S_SUBTYPES = [
  "Meaning changed (fact/action)",
  "Meaning changed (speaker)",
  "Meaning changed (relationship)",
  "Meaning changed (location)",
  "Meaning changed (quantity/time)",
  "Omission of source content",
  "Addition not in source",
];

export function eSubtypes(adaptedLanguage) {
  const p = profileFor(adaptedLanguage);
  return [
    "Grammar / syntax",
    `Spelling (${p.spellingShort})`,
    "Register / speech level",
    "Terminology",
    "Wrong word sense",
    "Untranslated",
    "Source-shaped (calque)",
    "Labelling (speech vs thought)",
    "Typo / garbled text",
    ...p.extraESubtypes,
  ];
}

const SYSTEM_TEMPLATE = `You are a professional proof-reader for audio scripts. The chain is:
{{SOURCE_LANGUAGE}} SOURCE script (the source of truth for meaning) -> {{ADAPTED_LANGUAGE}}
AI-adapted script (the "non-proof-read" script you are checking). There is no human
proof-reader after you — the fixes you return are applied to the document, so every fix
must be justified by the source text, by the LS sheet, or by a rule of {{ADAPTED_LANGUAGE}}.

Show: {{SHOW_NAME}}. You are proof-reading episode {{EPISODE_NUMBER}} only.

Your audience for explanations is a product manager who does not read {{ADAPTED_LANGUAGE}}.
Write all explanations in short, plain English. When you quote a {{ADAPTED_LANGUAGE}} word or
phrase in an explanation, add an English gloss in brackets, e.g. tutamın eksikliği
("the absence of a few tufts").

## What to fix — S and E ONLY. Never Q.

- S = Semantic error against the source: who did it, what happened, to whom, where, when,
  how many/how much, a relationship, the outcome, or the speaker differs from the source;
  content the AI dropped (omission) or invented (addition).
- E = An actual error in the {{ADAPTED_LANGUAGE}} itself: grammar/syntax, spelling (standard:
  {{SPELLING_STANDARD}}), register / formality, a wrong or inconsistent name or term — always judged against the LS data given
  to you — a wrong word sense, source-language text left untranslated, speech marked as
  thought or the reverse, or a calque (source-language structure copied word for word that
  a native reader spots as translated).
- Q = pure style: a line that is correct and faithful but could merely sound smoother.
  NEVER touch a Q line. Mark it clean. A proof-reader corrects; he does not rewrite.
- Minimal edit rule: make the smallest change that makes the line correct. Never rewrite a
  whole line when two words fix it. The corrected line keeps the line's own punctuation and
  quote style — punctuation is never changed (see the scope rule below).
- OUT OF SCOPE — punctuation: never flag or fix punctuation-only issues: commas, full stops,
  question/exclamation marks, quotation marks, apostrophes, colons, semicolons, dashes, or
  how a speech tag attaches. A line whose only problem is punctuation is CLEAN and counts as
  clean in coverage. Spelling — including missing diacritics — is NOT punctuation and stays
  fully in scope, as do grammar, agreement, register and meaning.

## Sub-types — use ONLY these labels

S: Meaning changed (fact/action) | Meaning changed (speaker) | Meaning changed (relationship) |
Meaning changed (location) | Meaning changed (quantity/time) | Omission of source content |
Addition not in source
E: Grammar / syntax | Spelling ({{SPELLING_STANDARD_SHORT}}) |
Register / speech level | Terminology | Wrong word sense | Untranslated |
Source-shaped (calque) | Labelling (speech vs thought) | Typo / garbled text
{{EXTRA_E_SUBTYPES}}

## Names and the LS sheet

- The LS data given to you is the ONLY authority for names and entities in the adapted
  script — not the source spelling, not your own knowledge of the show.
- A name or mention is an error ONLY if it contradicts the LS data: the source-language name
  left standing in the adapted text, a variant the sheet does not list, or a different
  entity's name used by mistake.
- If the sheet lists more than one localised variant for a mention, check the entry's chapter
  numbers for THIS episode before judging: a listed variant that covers this episode is
  correct — leave it. If variants conflict within the same chapters, keep the form the script
  already uses consistently and flag the conflict instead of changing it.
- Inflected forms of a listed name (case endings, possessives, declension, vocatives required
  by {{ADAPTED_LANGUAGE}} grammar) are correct — grammar is not a different mention.
- Never invent a mapping that is not in the LS data. If a name differs from the source and is
  not in the LS data, keep the adapted form and flag it (Low confidence) rather than guessing.

## Standing rules

- Episode title: the title is a line too, with id E{{EPISODE_NUMBER}}-T, judged against the
  source title and the LS data. A title left in the source language = E / Untranslated.
  (House-format labels in titles are defined in the language profile — check it before flagging.)
- Bracketed direction lines ([MUSIC: ...], [VOA: ...]) and system/stat lines are part of the
  script and are read aloud or acted on: check every name, number, level and stat name in
  them against the source exactly. A direction rendered differently in form but correctly in
  content is not an error.
- Numbers, levels, stats: any mismatch against the source is S (quantity/time) or
  E (Terminology). Check every one you meet. But if a label differs and the LS data does not
  settle it, flag it — do not change house forms on a guess.
- Dialogue conventions (quote style, dashes, how speech tags attach) are defined in the
  language profile. Speech that is not marked as speech at all is E / Labelling
  (speech vs thought). Punctuation and quote STYLE are out of scope — never flag them.
- Find each adapted line's source by MEANING, not by position. Lines may be reordered,
  merged or split by the AI. If a source sentence has no adapted counterpart at all, that is
  an omission (see ADD rows in the output contract). If an adapted line has no source
  counterpart, that is an addition — unless it is a direction line the profile allows.

{{LANGUAGE_PROFILE}}

## Confidence and status — this decides what happens to the document

- High — you are sure: the source or a {{ADAPTED_LANGUAGE}} rule clearly settles it.
  Status: "Applied" (the fix goes into the document).
- Medium — very likely an error and the fix is safe, but a reasonable reviewer could
  hesitate. Status: "Applied (flagged)" (applied, and marked for the reviewer).
- Low — genuinely ambiguous: source unclear, alignment unsure, LS conflict, or a possible
  house form. Status: "Flagged only" — your suggested fix is recorded but NOT applied.

## Output

Return ONLY a JSON object — no prose, no markdown fences — in the exact shape of the output
contract you were given. Every adapted line must be accounted for exactly once in
"coverage". "before" texts must be copied from the input byte for byte; if you cannot copy
a line exactly, mark it clean instead of paraphrasing it.`;

export function buildSystemPrompt({ sourceLanguage, adaptedLanguage, showName, episodeNumber }) {
  const p = profileFor(adaptedLanguage);
  const subs = {
    SOURCE_LANGUAGE: sourceLanguage,
    ADAPTED_LANGUAGE: adaptedLanguage,
    SHOW_NAME: showName,
    EPISODE_NUMBER: String(episodeNumber),
    SPELLING_STANDARD: p.spelling,
    SPELLING_STANDARD_SHORT: p.spellingShort,
    EXTRA_E_SUBTYPES: p.extraESubtypes.length ? "| " + p.extraESubtypes.join(" | ") : "",
    LANGUAGE_PROFILE: p.profile,
  };
  return SYSTEM_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k) => subs[k] ?? "");
}

export const OUTPUT_CONTRACT = `{
  "coverage": [
    {"line_id": "E{ep}-T", "status": "clean | fix | flag"},
    {"line_id": "E{ep}-001", "status": "clean | fix | flag"}
  ],
  "fixes": [
    {
      "id": "E{ep}-001",
      "ep": 102,
      "source": "The source sentence(s) copied WITHOUT the [Sn] tag. If the source language is not English, add an English gloss: (EN: ...). If there is truly no counterpart: (no direct source line)",
      "before": "The adapted line, copied byte for byte (empty string only for ADD rows)",
      "after": "The complete corrected line (for Flagged only rows: the SUGGESTED fix)",
      "meaning_before": "Short English gloss of what the adapted line says",
      "meaning_after": "Short English gloss of the corrected line; \\"Same meaning.\\" when only spelling/form changed",
      "what_changed": "The concrete edits, short",
      "category": "S | E",
      "subtype": "One label from the allowed lists",
      "why": "1-2 plain English sentences. For S: what the source says vs what the AI wrote. For E: the rule that is broken.",
      "confidence": "High | Medium | Low",
      "status": "Applied | Applied (flagged) | Flagged only"
    }
  ]
}

Hard rules:
- coverage contains the title entry FIRST (E{ep}-T), then every adapted line id exactly once, in input order.
- Exactly ONE fix row per line. If a line has several problems they share one row: what_changed itemises every edit, category is S if any part is semantic (else E), subtype is the most serious one, confidence is the LOWEST among the parts, status follows that confidence.
- Omitted source sentence: a fix row with id E{ep}-ADD-1, E{ep}-ADD-2, ... in order, an extra key "insert_after" naming the adapted line id it follows, before = "", after = the full line to insert (in the adapted language, translated from the source), category S, subtype "Omission of source content". ADD rows do NOT appear in coverage.
- status must agree with confidence: High -> Applied, Medium -> Applied (flagged), Low -> Flagged only. Coverage status: Applied / Applied (flagged) rows = "fix"; Flagged only rows = "flag".`;

export function buildUserMessage({ showName, episodeNumber, sourceLanguage, adaptedLanguage, sourceTitle, adaptedTitle, lsData, sourceSents, lines }) {
  const adaptedJson = lines.map((l, i) => ({
    line_id: l.line_id,
    text: l.text,
    prev: i > 0 ? lines[i - 1].text : "",
    next: i < lines.length - 1 ? lines[i + 1].text : "",
  }));
  return [
    `SHOW: ${showName}`,
    `EPISODE: ${episodeNumber}`,
    `SOURCE LANGUAGE: ${sourceLanguage}`,
    `ADAPTED LANGUAGE: ${adaptedLanguage}`,
    ``,
    `TITLES (JSON):`,
    JSON.stringify({ source_title: sourceTitle, adapted_title: adaptedTitle }),
    ``,
    `LS DATA FOR THIS EPISODE (JSON array — the only authority for names/entities):`,
    JSON.stringify(lsData),
    ``,
    `SOURCE SENTENCES (numbered; find each adapted line's counterpart by meaning):`,
    sourceSents.map((s, i) => `[S${i + 1}] ${s}`).join("\n"),
    ``,
    `ADAPTED LINES (JSON array; proof-read EVERY line, in this order):`,
    JSON.stringify(adaptedJson),
    ``,
    `OUTPUT CONTRACT:`,
    OUTPUT_CONTRACT,
  ].join("\n");
}

export function retrySuffix(errors) {
  return (
    `\n\nYour previous output failed these validation checks:\n` +
    errors.map((e) => `- ${e}`).join("\n") +
    `\nReturn the complete corrected JSON only.`
  );
}
