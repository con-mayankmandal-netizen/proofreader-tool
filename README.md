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

## The standalone app (in this repo)

A working web version lives here: submit form (show, both languages, the three
files) → Task ID → background processing → per-task downloads of the 3 input
originals and, once Ready, the 3 outputs. Processing follows SPEC.md exactly:
blocks of 5 episodes, one API call per episode, the §5 validation layer with
up to 3 attempts per episode, a deterministic pass 2 over the clean lines
(source-language name leaks), and outputs built only from validated results.

**Run locally**

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI and ONE provider key
npm start              # http://localhost:3000
```

Offline pipeline test (no key, no database; uses a stubbed model):
`npm run smoke` — add `-- path/to/source.docx path/to/adapted.docx path/to/ls.xlsx`
to run it on your own files.

**Deploy (Render + MongoDB Atlas, both have free tiers)**

1. MongoDB Atlas → create a free cluster → Database Access: add a user →
   Network Access: allow `0.0.0.0/0` → Connect: copy the connection string
   into `MONGODB_URI` (include the database name, e.g. `...mongodb.net/proofreader`).
2. Render → New → Blueprint → pick this repo (render.yaml is included), or
   New Web Service with build `npm install`, start `npm start`.
3. Set the env vars in the Render dashboard: `MONGODB_URI`, `MODEL_PROVIDER`
   (`mistral`, `claude` or `gemini`) and that provider's key. Keys are read
   server-side only and are never committed — `.env` is git-ignored.

**Known v1 limits (honest list)**

- No login/auth yet — anyone with the URL can submit and download. Put it
  behind the host's access control, or add auth before sharing the link widely.
- Output documents are rebuilt with the same paragraph styles (headings stay
  headings); run-level formatting inside a line (bold/italics on single words)
  is flattened.
- Language profiles exist for Turkish and Polish (the two proven pilots);
  other languages run on the general rules until a profile is written (§6 of
  the prompt pack explains how).
- Pass 2's second-model re-read is wired as an option (VERIFICATION_PROVIDER)
  but the deterministic checks always run; the name-leak flags are always
  "Flagged only" for a human to confirm.

## Storage

MongoDB. Tasks hold metadata/status; uploaded originals and generated outputs are
stored as files (GridFS when a file can exceed ~16 MB); extracted lines, LS subsets and
validated result JSON are stored per episode, keyed by
(taskId, episode, promptVersion, model).

## Secrets

API keys live server-side only, in environment variables (see `.env.example` when it
lands). Never commit a real key. `.env` is git-ignored.
