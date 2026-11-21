---
name: video-editing
description: Use when the user wants a video edited, cut, cleaned up or turned into a Short/TikTok/Reel/YouTube video — remove silences or « um/euh », add captions or music, reframe 16:9 to 9:16, punch-ins, B-roll, a look, or export a timeline to Premiere, DaVinci Resolve or Final Cut. CutKiller does the edit and scores it; do not hand-write ffmpeg for what it already does.
---

# Video editing with CutKiller

CutKiller edits real footage and returns a **quality report** (26 measured rules, score /100). Your job is the loop a good editor runs: **edit → read the report → fix → render again**, then hand over the file and, if asked, a timeline for a pro editor.

## 0. Which interface

1. MCP tools `auto_edit`, `plan_edit`, `read_edl`, `write_edl`, `render_edl`, `quality_check`, `export_timeline`, `list_styles`, `doctor` present → use them.
2. Otherwise the CLI: `cutkiller …` (from a clone: `pnpm cutkiller …`; Docker: `docker run --rm -v "$PWD:/work" -v cutkiller-models:/models ghcr.io/baldw1n69/cutkiller …`).
3. Anything fails unexpectedly → `doctor` first; it prints the fix for each problem.

Paths are on the machine running CutKiller. With Docker, only the mounted folder (`/work`) is visible: use relative paths inside it.

## 1. Frame the job (ask at most two questions, only if missing)

| Destination | Profile |
|---|---|
| TikTok, Reels, Shorts | `short` (9:16, punchy) or `cinematic-short` (9:16, calm) |
| YouTube | `long` (16:9) or `cinematic` (16:9, letterbox, film look) |

Language is detected per rush (`lang` to force it). Music is any audio file passed with the rushes. B-roll goes in `broll`.

## 2. First pass, in draft

`auto_edit { inputs, outDir, profile, draft: true }` — or `cutkiller auto <rushes…> <music> -p short -o out --draft`.
Expect roughly 1–3× the footage duration on a CPU the first time (models download once; analysis is cached).

## 3. Read the report, then decide

The summary lists the score and every failed rule with timecodes. Typical fixes:

| Failed rule | What to do |
|---|---|
| `montage.fillers` | A hesitation survived: `read_edl`, find the clip whose words include it (`why.wordIds`), move its `in`/`out` past the word, `write_edl`, `render_edl` |
| `montage.silences` | Same, tighten the clip edges (keep 80–120 ms around words) |
| `image.sharpness` | The source is too small for the output: say so; suggest `long` instead of `short`, or a better source |
| `image.reframe` | Several people or a subject leaving frame: suggest 16:9, or B-roll over that part |
| `audio.*` | Usually the input (clipping, very noisy): say so, it cannot be fixed by editing |
| `captions.*` | Re-run; if it persists, report the timecode |

Never claim a fix worked without re-running `quality_check`. Report the final score and what is still failing, honestly.

## 4. Final render and hand-off

- Final: `render_edl { draft: false }` (or `auto_edit` with `draft: false`).
- Deliver `final.mp4`, `final.srt` (platform subtitle track) and `quality.md`.
- A pro editor wants to finish it: `export_timeline` → `.xml` for Premiere Pro / Final Cut / Resolve, `.otio` for Resolve / Avid. Cuts, audio, music, punch-ins and a marker per decision travel; animations, grading, captions and SFX do not (say so).

## Limits (say them plainly)

No speed ramps or slow motion, no generated video or voice, no multicam switching yet; hesitation lists exist for en, fr, es, de, it, pt, nl, pl, ru, ar, zh, ja, fi, el, hu, fa (other languages: transcription and universal fillers only).
