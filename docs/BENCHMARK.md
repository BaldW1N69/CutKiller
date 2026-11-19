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
