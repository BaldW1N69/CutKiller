# Benchmark: CutKiller vs auto-editor

Same input, same machine, measured on 2026-11-19. Reproduce with the commands below.

- **Input**: 60 s of a French interview, 640×360 at 23.98 fps, -20.1 LUFS (Global Lives Project, CC BY 3.0: `pnpm rushes`, file `gl-vallee-360-60.mp4`), music Cely Grande « Thunder » (CC0).
- **Machine**: 4 CPU threads, 16 GB RAM, no GPU; speech models already downloaded.

| | auto-editor 29.3.1 | CutKiller (`-p short`) |
|---|---|---|
| Command | `auto-editor in.mp4` | `cutkiller auto in.mp4 music.mp3 -p short -o out` |
| Wall time | **6.6 s** | 9 min 45 s (analysis, render, 96 s of QA; the analysis is cached on re-runs) |
| Output length | 57.1 s (2.9 s removed) | 53.8 s (6.3 s removed) |
| What is cut | Low-volume audio | Silences > 350 ms with 80–120 ms margins, hesitations (« euh »), false starts |
| Cut accuracy | Audio threshold | Word boundaries (forced alignment, ~20 ms) |
| Format | 640×360 (unchanged) | 1080×1920, face-tracked 9:16 |
| Loudness | -20.1 LUFS (unchanged) | **-14.2 LUFS**, true peak ≤ -1 dBTP |
| Captions | — | 145 words, karaoke, safe zones, `.srt` |
| Music | — | Ducked under speech (-15 dB), cuts on beats |
| Rhythm | — | 23 shots, zoom cuts, 4 punch-ins on emphasis |
| Quality report | — | **97.8/100** on 26 rules (fails: ×5 upscale of a 640×360 source; 2 caption words 4 frames off) |

## Reading it honestly

- **auto-editor is ~90× faster** and is the right tool when all you need is dead air removed from a long recording. CutKiller is not trying to beat it on speed.
- **CutKiller does the rest of the edit** (format, captions, sound, rhythm) and tells you what is still wrong, with timecodes. On a 640×360 source it refuses to call the result sharp: the score reflects the input, not marketing.
- Speed is CutKiller's main weakness today: Whisper `large-v3-turbo` and the aligner on CPU. Planned: smaller model by default on CPU, GPU path, parallel analysis ([roadmap](https://github.com/BaldW1N69/CutKiller/blob/main/ROADMAP.md)).

## Reproduce

```sh
pnpm rushes                                   # downloads the CC-licensed rushes
uvx auto-editor .cache/rushes/gl-vallee-360-60.mp4 -o ae.mp4 --no-open
pnpm cutkiller auto .cache/rushes/gl-vallee-360-60.mp4 .cache/rushes/cely-grande-thunder.mp3 -p short -o out
ffmpeg -i ae.mp4 -af ebur128 -f null -       # loudness
```

## Where the time goes (A2, measured 2026-11-20)

Same machine (4 CPU threads, no GPU), 60 s French interview.

**Transcription** (Whisper + forced alignment + filler rescan), models already loaded:

| Model | Beam | Time | Words on the real rush | Ground truth found | Onset error p95 |
|---|---|---|---|---|---|
| large-v3-turbo (default) | 5 | 73 s | 146 | 23/28 | 9 ms |
| large-v3-turbo | 1 | 86 s | **125** (22 words lost) | 23/28 | 9 ms |
| small | 5 | 106 s | 146 | 22/28 | 9 ms |
| small | 1 | 72 s | 148 | 21/28 | 9 ms |

Decision: keep `large-v3-turbo` with beam 5. Greedy decoding drops words on real speech, and the small model is not faster once the alignment it shares with the large one is counted. Speed has to come from elsewhere.

**Per stage** (same rush, warm models, idle machine, two runs): Whisper 16–19 s, forced alignment 7 s, **filler rescan 40–56 s**. The rescan re-transcribes a window around every word that lasts longer than its letters explain (36 windows on this rush, 102 on the 180 s one), hoping Whisper writes a hidden « euh » in a short context. On 240 s of real interviews and the synthetic fixture it found **no** hesitation the first pass had missed: the disfluent prompt already makes Whisper write them. It is now opt-in (`CUTKILLER_FILLER_RESCAN=1`). Transcription of the 60 s rush: **73 s → 24–26 s**, same 146 words. Caveat: one French speaker; a speaker whose hesitations Whisper smooths over may still benefit from it.

**Whole Short from the 60 s rush** (`cutkiller auto`, short profile, cold cache, models loaded once): 321 s = analysis 51 s (transcription 43 s with model loading and language detection) + render 160 s (1,613 frames at 10.8 fps) + quality check 109 s. Score 97.8/100, unchanged.

**Render** (same machine, 54 s Short, 1,613 frames): CPU split while rendering — x264 encoder 2.3 cores, FFmpeg decoder 1.1, Node compositing 0.4. Encoder presets at the delivery bitrate (20 Mbps CBR, 1080×1920), quality against the uncompressed frames:

| Content | Preset | Encode time | PSNR | SSIM |
|---|---|---|---|---|
| Soft interview (×5.7 upscale), 600 frames | medium | 29.8 s | 54.6 dB | 0.9973 |
| | faster | 19.4 s | 53.7 dB | 0.9968 |
| | veryfast | 10.9 s | 52.9 dB | 0.9964 |
| Dense temporal film grain, 240 frames | medium | 13.5 s | 37.01 dB | 0.893 |
| | faster | 7.7 s | 37.04 dB | 0.896 |
| | veryfast | 4.4 s | 36.12 dB | 0.891 |
| Screen recording (text), 1920×1080 | all | 1.2–1.6 s | 94 dB | 1.000 |

Decision: `faster` for delivery (equal on the hardest case), `veryfast` stays for drafts. Whole render 155 s → 122 s. The decoder's cost is the contrast-adaptive sharpening after upscaling (6× the cost of the resize alone): it multiplies fine detail by 5.4 (Laplacian variance 1.84 → 10.0), sharpening before the resize only reaches 2.6, so it stays.

**Same Short after these changes**: render 121 s, quality check 89 s (was 109 s, the check re-transcribes the render), score 97.9/100. With the 51 s cold analysis: about 261 s instead of 321 s.

**Model loading**: 9.2 s per Python process (Whisper 3.4 s, aligner 4.9 s, partly spent asking the Hugging Face Hub about files already cached). A run starts about ten worker processes. Now: one persistent worker per run, and cached models load offline (7.7 s per cold load). Measured on the quality check of a 54 s Short, two runs each on an idle machine: 99 / 94 s with one process per task, 90 / 89 s with the persistent worker, **7 % faster**. A first measurement (178 → 88 s) was wrong: another job was running during the one-process run.

**Quality check** of a 54 s Short (96 s in total), slowest rules: duplicate frames 28.6 s, caption sync 19.1 s, fillers (re-transcription) 15.4 s, reframing 13.2 s. Next candidates: a lower decode resolution for duplicate frames (needs recalibrating the rule), reusing the analysis transcript for fillers.
