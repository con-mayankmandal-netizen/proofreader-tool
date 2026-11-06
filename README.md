# Proofreader Tool

An AI proof-reading tool for adapted audio scripts. It proof-reads an AI-adapted
("non-proof-read") script line by line against the original source script, using the
show's LS (localisation) sheet as the only authority for names and entities. It fixes
**semantic (S)** and **error/grammar (E)** problems only — it never rewrites for style,
and it never invents content. Correctness beats speed.

Built from two verified pilots (German→Turkish, English→Polish) run with the exact
prompt in `PROMPT_PACK.md`.

## How it works

1. **Submit a task** — show name, source language, adapted language, and three files:
   source script (.docx), LS sheet (.xlsx), adapted script (.docx). The task gets an ID.
2. **Processing** — the scripts are split into episodes by Heading style and processed
   in **blocks of 5 episodes** (a 100-episode document = 20 blocks), one API call per
   episode, each result mechanically validated before it is accepted. A second
   verification pass then re-checks the lines the first pass marked clean, because the
   top priority is catching **all** E + S errors.
3. **Outputs** (downloadable from the task, together with the original input files):
   - **Review document** — the original adapted text with every issue highlighted in
     place (red = E, yellow = S), nothing applied, each highlight carrying a comment
     (fix ID, sub-type, why, suggested correction) anchored on the exact words.
   - **Corrected document** — all approved fixes applied, clean, production-ready.
   - **Change log** — Excel (or CSV): every fix with before/after, meanings, category,
     sub-type, why, confidence and status, plus a summary and a
     "Needs human decision" list.

Full processing and output rules: [`SPEC.md`](SPEC.md).
The model prompt, output contract, validation layer and language profiles:
[`PROMPT_PACK.md`](PROMPT_PACK.md).

## Which API to use

- **Claude (recommended, model of record).** The prompt pack, its few-shot examples and
  the confidence discipline were built and proven on Claude pilots. Use a frontier-tier
  Claude (Sonnet class for volume, Opus class if quality dips). Strict JSON behaviour
  via tool-use / structured output.
- **Gemini (recommended as the second pair of eyes).** Run the verification pass over
  clean lines with Gemini: a different model family catches different misses, which is
  exactly what the recall pass is for. Its response-schema mode fits the output contract.
- **Mistral (not recommended for the main pass).** A tier below the other two on strict
  schema-following and on subtle cross-language semantic alignment (speaker swaps,
  quantity shifts) in languages like Turkish and Polish. Acceptable, at most, as a cheap
  pre-screen — never as the proof-reader of record.

Rules that apply to all three: one model of record per task (never mix mid-show —
name/variant judgements must stay consistent across episodes), temperature 0, and every
response passes the validation layer in `PROMPT_PACK.md` §5 before anything is stored.

## Storage

MongoDB. Tasks hold metadata/status; uploaded originals and generated outputs are
stored as files (GridFS when a file can exceed ~16 MB); extracted lines, LS subsets and
validated result JSON are stored per episode, keyed by
(taskId, episode, promptVersion, model).

## Secrets

API keys live server-side only, in environment variables (see `.env.example` when it
lands). Never commit a real key. `.env` is git-ignored.
