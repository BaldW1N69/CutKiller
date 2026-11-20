# Getting started

## 1. Install

=== "Docker (nothing else to install)"

    ```sh
    docker run --rm ghcr.io/baldw1n69/cutkiller doctor
    ```

    Mount your project folder on `/work` and a named volume on `/models` (speech models are downloaded once, on first use).

=== "From source"

    Requirements: Node 22+, pnpm 10 (`corepack enable`), FFmpeg 6+, [uv](https://docs.astral.sh/uv/).

    ```sh
    git clone https://github.com/BaldW1N69/CutKiller && cd CutKiller
    pnpm install && (cd workers && uv sync)
    pnpm cutkiller doctor
    ```

`doctor` checks FFmpeg, the Python workers, the compositor, the models, GPU and memory, and prints the command that fixes each problem.

## 2. First edit

```sh
cutkiller auto interview.mp4 music.mp3 -p short -o out --draft
```

| Profile | For |
|---|---|
| `short` | TikTok, Reels, Shorts (9:16, punchy) |
| `cinematic-short` | 9:16, calmer: longer shots, dissolves, film look |
| `long` | YouTube (16:9) |
| `cinematic` | 16:9 with letterbox and film look |

`out/` then holds `final.mp4`, `final.srt`, the editable `edit.edl.json` and the report `quality.md`. `--draft` encodes fast; drop it for the final render.

## 3. Read the report, fix, render again

Every failed rule lists timecodes. Most fixes are a small change in `edit.edl.json` (move a clip's `in`/`out` past a word that slipped through), then:

```sh
cutkiller render out/edit.edl.json -o out/final.mp4
cutkiller check out/final.mp4 --edl out/edit.edl.json -p short --md out/quality.md
```

Some failures describe the input, not the edit — e.g. `image.sharpness` on a 640×360 source: the report says so instead of hiding it.

## Edit by transcript (Studio)

```sh
cutkiller studio interview.mp4 music.mp3 -p short -o out
```

Open http://localhost:4317: every sentence of the rushes is listed with a checkbox. Untick what you don't want, click **Render draft**, and the edited video appears with its quality score and the rules it fails. **Render final** encodes at full quality. Your selection is saved in `out/studio.json`.

## One long video → many Shorts

```sh
cutkiller shorts podcast.mp4 music.mp3 -p short -o shorts --count 5 --min 15 --max 60
```

CutKiller splits the transcript into sentences, finds the passages that open on their strongest line (a question, a number, a bold claim) and hold one complete idea, then edits, renders and scores each clip. `shorts/shorts.md` ranks them by hook and quality score.

With `--ai`, Claude chooses the clips instead (it can move the hook to the front and drop digressions). It needs Anthropic credentials where CutKiller runs (`ANTHROPIC_API_KEY`); without them, or if the request fails, CutKiller uses the offline planner and says so.

## A short version of a long video

```sh
cutkiller auto talk.mp4 music.mp3 -p long -o recap --target 60
```

`--target` keeps the strongest sentences up to that many seconds of speech, opens on the strongest hook and keeps the rest in its original order. Add `--ai` to let Claude choose them.

## Options

| Option | |
|---|---|
| `--lang en` | Force the spoken language (default: detected per rush) |
| `--look neon-80s` | Image style; `cutkiller looks` lists them |
| `--broll street.mp4` | Cutaways (repeatable) |
| `--broll-search "harbor boats"` | Finds free cutaways: Pexels with `PEXELS_API_KEY`, else Wikimedia Commons (public domain, CC0, CC BY only); credits in `credits.txt` |
| `--min-score 90` | Exit code 1 below that score (CI-friendly) |
| `CUTKILLER_LANG=fr` | Messages and reports in French |
| `CUTKILLER_WHISPER_MODEL=small` | Lighter, faster transcription model |
| `CUTKILLER_DEVICE=cuda` | Force the NVIDIA GPU (auto-detected by default; needs a CUDA build of PyTorch for the aligner) |
| `CUTKILLER_BEAM=1` | Greedy transcription: faster, slightly less accurate |
| `CUTKILLER_TIMINGS=0` | Hide the per-stage timings |
| `CUTKILLER_WORKER_MODE=oneshot` | One Python process per analysis task instead of one persistent worker |

## Measure it yourself

```sh
pnpm bench            # edits the CC-licensed test rushes, records stage timings and quality scores
```

Results land in `bench/results/results.md`, one row per run and commit.
