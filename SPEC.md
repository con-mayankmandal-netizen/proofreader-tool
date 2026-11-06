# Proofreader Tool — Build Spec

Locked requirements for the standalone tool. The model-facing rules (what counts as an
error, confidence gating, sub-types, LS authority) live in `PROMPT_PACK.md`; this file
covers product behaviour: intake, processing shape, outputs and downloads.

## Purpose and limits

- The tool **proof-reads**. It does not write, adapt, or improve creatively.
- **Punctuation is out of scope** (decided 2026-11-06): commas, full stops, quotation
  marks, apostrophes, colons/semicolons and dashes are never flagged or fixed, in either
  pass. Spelling — including missing diacritics — grammar, agreement, register and
  meaning remain fully in scope.
- It corrects an adapted line only when the source script, the LS sheet, or a rule of the
  adapted language proves the line wrong. Anything not provable is flagged for a human,
  never guessed.
- Speed is explicitly secondary. A slow, correct run beats a fast, approximate one.

## Task intake

- Submit form: show name; **source language** and **adapted (non-proof-read) language**
  dropdowns (chosen before upload — they select the language profile); three uploads:
  - Source script (.docx) — the source of truth for meaning.
  - LS sheet (.xlsx) — the only authority for names/entities. Always required.
  - Adapted script (.docx) — the AI output to be proof-read.
- On submit the task is stored and a **Task ID** is generated and shown.
- Statuses: `Submitted → Processing → Ready` (or `Failed`, with the failing episodes
  listed). Processing runs in the background; the submitter does not wait on the page.

## Downloads

Every task offers downloads of **both sides**:

- **Input files** — the three originals, byte-for-byte as uploaded (source .docx,
  adapted .docx, LS .xlsx).
- **Output files** — the three outputs below, available once the task is `Ready`.

## Processing design

- Split source and adapted scripts into episodes by Heading paragraph styles.
- Process in **blocks of 5 episodes**: a 100-episode document is 20 blocks
  (5 × 20). Blocks run one after another; a block starts only when the previous block
  is fully validated and stored.
- **Inside a block, one API call per episode** (see `PROMPT_PACK.md` §1): the episode's
  source sentences, adapted lines, titles, and its LS subset. Per-episode calls keep
  alignment exact and confine any failure to a single episode.
- Every response passes the validation layer (`PROMPT_PACK.md` §5) — byte-exact
  before-texts, full line coverage, allowed sub-types, confidence/status pairing.
  Failure → retry with the error list (max 3) → episode marked failed for a human.
  One exception (owner decision, 2026-11-06): a fix row whose sub-type is a
  punctuation label is out of scope, so the validator DROPS it (never applied,
  counted in the task summary's warnings) instead of failing the episode for it.
- **Partial documents** (owner request, 2026-11-06): if a run stops partway —
  some episodes failed validation, or the model API died (e.g. quota) — the
  documents are still built from the COMPLETED episodes and the task is marked
  `Partial` with the missing episodes named. Unfinished episodes appear in the
  documents exactly as submitted (never silently proofread). Only a run with
  zero completed episodes produces no documents. A model API error stops the
  run immediately instead of burning further episodes into a dead quota.
- **Pass 2 — recall sweep (mandatory).** The first pass's "clean" lines are re-checked:
  1. deterministic pattern checks per language profile (source-language name leaks,
     number/stat mismatches, untranslated fragments — punctuation patterns excluded,
     punctuation is out of scope);
  2. a second model (different family from the main pass where available) re-reads the
     clean lines against the source, S + E only.
  New finds become fixes under the same confidence rules. The task summary reports how
  many fixes pass 2 added — the measured miss count of pass 1.
- **No invention.** The model may not create content, mappings, or corrections that the
  source, the LS sheet, or a language rule does not support. Unsettled items are
  "Flagged only" with a suggested fix and the reason for doubt.

## The 3 outputs

### 1. Review document (.docx) — issues highlighted, NOT applied
- The adapted script exactly as submitted — **no fix is applied** in this document.
- Every E/S issue is highlighted **in place, on the problem words**:
  **red highlight = E** (error/grammar), **yellow highlight = S** (semantic).
  If a line has both, the semantic (yellow) wins for that span.
- Every highlight carries a **Word comment anchored on the highlighted span**, so the
  reader can map comment ↔ line at a glance. The comment shows, in this order:
  Fix ID · Category + Sub-type · Status/confidence · Why (what is wrong, quoting the
  source or the rule) · Suggested correction (the full corrected line).
- Flagged-only issues appear the same way; their comments say "Suggested — not applied".
- Episode headings, styles and all other formatting are preserved untouched.

### 2. Corrected document (.docx) — fixes applied
- All `Applied` and `Applied (flagged)` fixes applied; `Flagged only` fixes NOT applied.
- Clean: no highlights, no comments. Headings, styles and formatting preserved.
- Verified before delivery: diffing it against the submitted adapted script shows
  exactly the applied fixes and nothing else.

### 3. Change log (.xlsx; CSV export of the same data must also be possible)
- **Change Log** sheet — one row per fix:
  ID | Episode | Source line | Before (adapted) | After (fixed; the suggestion for
  flagged rows) | Meaning of Before | Meaning of After | What changed | Category (S/E) |
  Sub-type | Why | Confidence | Status (Applied / Applied (flagged) / Flagged only).
- **Summary** sheet — totals; S/E split; applied vs flagged; per-episode counts;
  coverage (lines checked / clean / fixed / flagged); pass-2 finds.
- **Needs Human Decision** sheet — every Flagged only row with its suggested fix and
  the reason for doubt.
- Filtered views: Semantic Fixes | Error Fixes | Name & Mention Fixes (LS).

## Storage (MongoDB)

- `tasks`: show, languages, episode range, status, timestamps, prompt version, models
  used (main + verification), per-episode status roll-up.
- Files (GridFS, or BinData while files stay small): the 3 input originals; the 3
  outputs. Keep original filenames.
- `episodes`: extracted source sentences, adapted lines, LS subset used, validated
  result JSON (coverage + fixes), validation report. Keyed by
  (taskId, episode, promptVersion, model) so re-runs are idempotent per episode.

## API usage

- Keys server-side only, from environment variables; never in the repo, never in the
  browser.
- One **model of record** per task for the main pass (consistency of name/variant
  judgements across episodes). The verification pass may use a different model family.
- Temperature 0; structured JSON output where the provider offers it; validation still
  always runs.
