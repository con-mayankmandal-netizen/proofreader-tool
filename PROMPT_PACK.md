# Proofreader — Production Prompt Pack

For the standalone version of the proofreader tool (GitHub + MongoDB + Claude or Gemini API).
This pack is the distilled, production form of the exact briefs that produced the two verified
pilots (German→Turkish Ep 101–105: 23 fixes; English→Polish Ep 1–5: 28 fixes). Do not improvise
a new prompt — use this one, and change it only by editing the language profile blocks.

Contents:
1. How the pipeline calls the model (read this first)
2. System prompt (verbatim, with placeholders)
3. User message template (the per-episode payload)
4. Output contract (the JSON the model must return)
5. Server-side validation — the foolproofing layer (never skip)
6. Language profiles (the slot, plus the two proven profiles)
7. Worked examples (real rows from the pilots)
8. API settings and notes (Claude / Gemini)

---

## 1. How the pipeline calls the model

- **One API call per episode.** Never send a whole book: alignment quality collapses and a single
  malformed response would poison hundreds of lines. Episodes are independent — call them in
  parallel (respect the provider's rate limits) and store each episode's result separately.
- **Code assembles the payload**, the model never sees raw .docx/.xlsx:
  - Source script → split into numbered sentences `[S1]…[Sn]` (split on the source language's
    sentence rules; keep bracketed direction/stat lines as their own sentences).
  - Adapted script → split into lines (the same line split the renderer uses: paragraph lines,
    split at line breaks). Each line gets an id `E{ep}-{NNN}` in document order, plus `prev`/`next`
    neighbour text for context.
  - LS sheet → build the **episode subset**: every entity whose original or localised name/mention
    appears in this episode's source or adapted text, plus the show's main cast always. Each entry:
    original name, localised name, gender, and all mention variants **with their chapter numbers**.
    If the whole sheet is small (under ~150 entities), sending it whole is also fine.
  - Titles: source title + adapted title for the episode.
- **The model's raw response is never trusted.** It goes through §5 validation before it is
  stored or rendered. On validation failure, re-call with the validation errors appended
  ("Your previous output failed these checks: …") — max 3 attempts, then mark the episode
  `failed` for a human to look at. Never silently accept, never partially apply.
- Store per task in MongoDB: the uploaded files (binary — use GridFS if a file can exceed
  ~16 MB; otherwise a BinData field is fine), the extracted lines/sentences, the LS subset used,
  and the validated result JSON per episode. Store the prompt version (below) with every result,
  so a result can always be traced to the exact prompt that produced it.
- `PROMPT_VERSION = "1.0"` — bump it whenever any text in §2, §3 or §6 changes.

---

## 2. System prompt (verbatim)

Replace the `{{...}}` placeholders per job. `{{LANGUAGE_PROFILE}}` is filled from §6.

```
You are a professional proof-reader for audio scripts. The chain is:
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
a line exactly, mark it clean instead of paraphrasing it.
```

---

## 3. User message template (per episode)

```
SHOW: {{SHOW_NAME}}
EPISODE: {{EPISODE_NUMBER}}
SOURCE LANGUAGE: {{SOURCE_LANGUAGE}}
ADAPTED LANGUAGE: {{ADAPTED_LANGUAGE}}

TITLES (JSON):
{"source_title": "...", "adapted_title": "..."}

LS DATA FOR THIS EPISODE (JSON array — the only authority for names/entities):
[ {"original": "...", "localised": "...", "gender": "Male|Female|",
   "mentions": [ {"original_mention": "...", "localised_mention": "...", "chapters": "..."} ]} ]

SOURCE SENTENCES (numbered; find each adapted line's counterpart by meaning):
[S1] ...
[S2] ...

ADAPTED LINES (JSON array; proof-read EVERY line, in this order):
[ {"line_id": "E{{EPISODE_NUMBER}}-001", "text": "...", "prev": "...", "next": "..."} ]

OUTPUT CONTRACT:
{ ...the JSON shape from §4 of the prompt pack, pasted in full... }
```

---

## 4. Output contract

The model returns exactly this shape (this is the same `fixes.json` shape the pilots used —
it is proven, and it maps directly onto the app's stored result):

```json
{
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
      "meaning_after": "Short English gloss of the corrected line; \"Same meaning.\" when only spelling/form changed",
      "what_changed": "The concrete edits, short",
      "category": "S | E",
      "subtype": "One label from the allowed lists",
      "why": "1–2 plain English sentences. For S: what the source says vs what the AI wrote. For E: the rule that is broken.",
      "confidence": "High | Medium | Low",
      "status": "Applied | Applied (flagged) | Flagged only"
    }
  ]
}
```

Hard rules for the output:

- `coverage` contains the title entry FIRST (`E{ep}-T`), then every adapted line id exactly
  once, in input order. Length = number of adapted lines + 1.
- Exactly **one** fix row per line. If a line has several problems, they share one row:
  `what_changed` itemises every edit, `category` is S if any part is semantic (else E),
  `subtype` is the most serious one, `confidence` is the LOWEST confidence among the parts
  (a line is only as safe as its riskiest edit), and `status` follows that confidence.
- Omitted source sentence (no adapted line exists): a fix row with id `E{ep}-ADD-1`,
  `E{ep}-ADD-2`, … in order, an extra key `"insert_after"` naming the adapted line id it
  should follow, `before` = `""`, `after` = the full line that should be inserted (in the
  adapted language, translated from the source), category S, subtype
  "Omission of source content". ADD rows do not appear in `coverage`.
- `status` must agree with `confidence`: High → Applied, Medium → Applied (flagged),
  Low → Flagged only. Coverage status: Applied/Applied (flagged) rows = "fix",
  Flagged only rows = "flag".
- For "Flagged only" rows the document is NOT changed: the renderer shows `after` as a
  suggestion inside the comment only.
- The renderer builds highlights by word-diffing `before` → `after` on applied rows, so
  `after` must differ from `before` only by the actual edits (another reason for the
  minimal edit rule). A line whose category is S is highlighted yellow, E is red.
```

---

## 5. Server-side validation — the foolproofing layer

Run ALL of these on every response before storing or rendering. Any failure → re-call with the
error list appended (max 3 attempts) → episode marked `failed`. This layer, not the prompt, is
what makes the system foolproof: the prompt asks, the validator enforces.

1. Response parses as JSON and has exactly the keys `coverage` and `fixes`.
2. `coverage` length = adapted lines + 1; first entry is the title id; every input line id
   appears exactly once, in order; every status ∈ {clean, fix, flag}.
3. Every fix row's `id` exists in coverage with the matching status (fix ↔ Applied /
   Applied (flagged); flag ↔ Flagged only) — except ADD rows, which must NOT be in coverage
   and whose ids must be sequential `E{ep}-ADD-1…` with a valid `insert_after`.
4. **`before` of every non-ADD row equals the input line's text byte for byte.** (This single
   check kills most hallucinated or misaligned output. If it fails, the episode fails.)
5. `after` ≠ `before` on every row; on Flagged only rows `after` is stored as a suggestion only.
6. `category` ∈ {S, E}; `subtype` ∈ the allowed lists (including profile additions);
   `confidence`/`status` pairing follows the contract.
7. Counts reconcile: fixes + flags in `fixes` = rows with status fix/flag in `coverage`;
   report per-episode totals (lines checked, clean, S, E, Applied, Applied (flagged),
   Flagged only) and store them with the result.
8. Sanity diff: applying all Applied + Applied (flagged) `after`s to the adapted lines must
   reproduce the corrected document exactly — build the corrected doc from the validated JSON,
   never from a second model output.

**Out-of-scope drop (owner decision, 2026-11-06):** before checks 2–8 run, any fix row whose
sub-type is a punctuation label (`Punctuation`, comma/quote/dash labels, …) is DROPPED — never
applied, never stored — and the episode does NOT fail for it; a line whose only rows were
dropped counts as `clean` in coverage. The drop count and sub-types are recorded in the task
summary's warnings. Rationale: punctuation is out of scope by product decision, so a model
that returns such a row anyway has produced a row the tool would never use; failing a whole
episode over it (the old behaviour) cost real runs. All other checks stay strict — in
particular check 4 (byte-exact `before`) still fails the episode.

Retry prompt suffix (append to the user message on attempts 2–3):

```
Your previous output failed these validation checks:
- {one line per failed check, e.g. "coverage is missing line E102-087"}
- {"before" of E102-041 does not match the input line byte for byte}
Return the complete corrected JSON only.
```

---

## 6. Language profiles

The system prompt has one `{{LANGUAGE_PROFILE}}` slot and three spelling placeholders. A profile
is a short block of target-language rules that generic prompting gets wrong. Everything else
stays identical across pairs — that is what makes a new language pair a configuration change,
not a rebuild. The two proven profiles:

### 6a. Adapted language = Turkish (used with German source in the pilot)

Placeholders: `SPELLING_STANDARD` = "TDK standard", `SPELLING_STANDARD_SHORT` = "TDK",
`EXTRA_E_SUBTYPES` = "" (none).

```
LANGUAGE PROFILE — TURKISH (adapted):
- Spelling standard is TDK. Watch for missing or wrong circumflex-free spellings and
  apostrophe use with proper names (Arda'ya, "to Arda").
- Case and possessive suffixes on names are grammar, not different mentions: a listed name
  with a Turkish suffix chain is the same mention.
- Vowel harmony violations in suffixes are E / Grammar / syntax.
- Dialogue in quotes (straight or curly) is the convention; speech not marked as speech at
  all = E / Labelling. Punctuation and quote style are out of scope — never flag them.
- Word order copied from German (verb pushed unnaturally, genitive chains mirroring German)
  that a native reader spots as translated = E / Source-shaped (calque).
```

### 6b. Adapted language = Polish (used with English source in the pilot)

Placeholders: `SPELLING_STANDARD` = "Polish orthography, including diacritics ą ć ę ł ń ó ś ź ż",
`SPELLING_STANDARD_SHORT` = "Polish orthography", `EXTRA_E_SUBTYPES` = "| Gender ending (Polish)".

```
LANGUAGE PROFILE — POLISH (adapted):
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
  format — do not flag it; judge only the title's meaning against the source title.
```

### Writing a new profile

Keep it under ~15 bullets and only include rules that (a) the generic model reliably gets
wrong in that language, and (b) can be checked mechanically against the source or the LS data:
spelling standard + its short name, extra E sub-types (if any), dialogue convention,
gender/register systems the LS data can arbitrate, and any
house-format exceptions. Test a new profile on 3–5 pilot episodes and human-spot-check before
running a full show — exactly how the two profiles above were proven.

---

## 7. Worked examples (real rows from the verified pilots)

**Example 1 — E, Applied (High).** Turkish grammar the AI broke; source uninvolved beyond meaning.

```json
{
  "id": "E101-004", "ep": 101,
  "source": "Er presste seltsam verkrampft seine Hand an den Bauch und ihm fehlten sogar ein paar Haarbüschel. (EN: He pressed his hand, strangely cramped, against his stomach, and he was even missing a few tufts of hair.)",
  "before": "Elini tuhaf bir kasılmayla karnına bastırıyor, saçındaki birkaç tutam eksiklik göze çarpıyordu.",
  "after": "Elini tuhaf bir kasılmayla karnına bastırıyor, saçındaki birkaç tutamın eksikliği göze çarpıyordu.",
  "meaning_before": "He was pressing his hand to his stomach with a strange cramp, and 'a few tufts deficiency' in his hair caught the eye (garbled).",
  "meaning_after": "He was pressing his hand to his stomach with a strange cramp, and the absence of a few tufts of his hair caught the eye.",
  "what_changed": "\"birkaç tutam eksiklik\" (broken phrase) -> \"birkaç tutamın eksikliği\" (\"the absence of a few tufts\").",
  "category": "E", "subtype": "Grammar / syntax",
  "why": "In Turkish \"eksiklik\" (\"deficiency\") cannot stand like that after \"birkaç tutam\" (\"a few tufts\"); the phrase needs the possessive form \"tutamın eksikliği\". A native reader stumbles on the AI's wording.",
  "confidence": "High", "status": "Applied"
}
```

**Example 2 — E, Flagged only (Low).** The numbers match, the label doesn't, and the LS sheet
doesn't settle it — so it is flagged, NOT changed. This restraint is deliberate; teach it.

```json
{
  "id": "E104-047", "ep": 104,
  "source": "[42/55 VP] [38/55 VP] [34/55 VP] (EN: his points drop to 42/55, then 38/55, then 34/55 VP)",
  "before": "Kırk iki bölü elli beş C P. Otuz sekiz bölü elli beş C P. Otuz dört bölü elli beş C P.",
  "after": "Kırk iki bölü elli beş V P. Otuz sekiz bölü elli beş V P. Otuz dört bölü elli beş V P.",
  "meaning_before": "His points fall as the stones hit: 42 of 55, 38 of 55, 34 of 55, labelled 'C P'.",
  "meaning_after": "The same three falls, with the stat labelled 'V P' as in the source.",
  "what_changed": "Suggested only: stat label 'C P' -> 'V P' (three times). Numbers unchanged.",
  "category": "E", "subtype": "Terminology",
  "why": "The numbers match the source exactly, but the stat name does not: the source writes VP and no LS entry supports 'C P'. Flagged, not applied, because CP may be the series' own house form for this stat in other episodes; a human should confirm before it is changed everywhere.",
  "confidence": "Low", "status": "Flagged only"
}
```

**Example 3 — OUT OF SCOPE: punctuation is never flagged.** In the Polish pilot, comma
placement was the single biggest E class (13 of its 18 E fixes). By product decision
(2026-11-06) punctuation is out of scope: a line whose only issue is punctuation produces
NO fix row and counts as clean in coverage. The line below was flagged in the pilot —
today the correct behaviour is to leave it exactly as it is. (Spelling, including missing
diacritics, is not punctuation and is still fixed.)

> Puryści twierdzili, że zdolności to plaga dla ludzkości, i woleli polegać na tradycyjnym orężu.
> (The comma before "i" breaks a Polish comma rule — and is still NOT flagged: punctuation is out of scope.)

Correct output for this line: no entry in `fixes`; the line_id appears in `coverage` only.

---

## 8. API settings and notes

- **Temperature 0** (or the lowest available). This is a checking task, not a creative one.
- **Structured output:** on Claude, use tool-use / JSON-schema output if available; on Gemini,
  set `responseMimeType: "application/json"` and a `responseSchema` matching §4. Either way,
  still run §5 validation — schema modes reduce, not eliminate, malformed output.
- **Model choice:** use a frontier-tier model for the proofreading call (Claude Sonnet/Opus
  class, Gemini Pro class). Cheaper tiers measurably miss the subtle semantic class (speaker
  swaps, quantity shifts) that this tool exists to catch. The pilots behind this pack were run
  at frontier tier.
- **Context size:** one episode ≈ 150–200 adapted lines + source sentences + LS subset —
  comfortably inside any frontier model's context. If an episode is unusually long, split it at
  a scene break and give each half the full LS subset; never split mid-line.
- **Keys:** the API key lives server-side only, in an environment variable, never in the repo
  (`.env` in `.gitignore`). The browser/front-end must never see it — all model calls go
  through your backend.
- **Idempotency:** key each stored result by (taskId, episode, promptVersion, model). Re-running
  an episode overwrites only that episode's result.
