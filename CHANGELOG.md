# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Security
Audit of the whole code for a shared-service use ([report](docs/security/AUDIT-2026-11-20.md), [SECURITY.md](SECURITY.md)):
- **FFmpeg inputs restricted to local files of self-contained media formats**: a `.m3u8` playlist sent as a rush made FFmpeg read another file of the machine into the render (reproduced, now refused; TS and Python tests).
- **`CUTKILLER_WORKSPACE`**: every user path (rushes, EDL sources, outputs, MCP arguments) must stay inside it, `..` and symlinks included. `read_edl` only returns a valid EDL; `write_edl` only writes `.json`.
- **Studio**: session key in the printed link (HttpOnly SameSite cookie), Host and Origin checks, JSON-only render API, 413 over 1 MB. Blocks CSRF and DNS rebinding.
- **EDL limits** (4096 px, 120 fps, 400 Mbps, 4 h, bounded collections) and a 100 MB cap on music downloads.
- **Downloads**: https and public addresses only, each redirect re-checked, FFmpeg limited to https for remote media.
- **Dependencies**: zod 4.6.6 (HIGH advisory); Python index restricted to torch, which brought urllib3 1.26 → 2.8, requests 2.28 → 2.34, certifi, idna, filelock, setuptools up to date; `pnpm audit` and `pip-audit` in CI.
- **Docker image runs as an unprivileged user** (uid 10001); run it with `-u "$(id -u):$(id -g)"`.

### Changed
- **Transcription 2.9× faster** (60 s of speech: 73 s → 25 s on 4 CPU threads, same 146 words): the second, local Whisper pass that looked for hidden hesitations is now opt-in (`CUTKILLER_FILLER_RESCAN=1`). On 240 s of real interviews it found none the first pass had missed and took 60–70 % of the transcription time; the quality check, which re-transcribes the render, gets the same saving.

- **Final renders 21 % faster** (54 s Short: 155 s → 122 s): delivery encodes use x264 `faster` instead of `medium`. At the delivery bitrate they measured the same: PSNR 37.04 vs 37.01 dB and SSIM 0.896 vs 0.893 on dense film grain (the hardest case), transparent on screen text, -0.9 dB at 54 dB on a soft interview. `veryfast` was rejected (-0.9 dB on grain). The upscale sharpening was kept: it multiplies fine detail by 5.4 (Laplacian variance), a visible effect, though it costs most of the decoding time.

### Fixed
- Captions and the margin checks now follow the sound, not the picture: a J/L cut written by hand in the EDL put the words under the neighbouring shot at the wrong time.
- **`render` then `check` reported false caption-sync errors** (99.3 % → 92.4 % on the same video): `render` only kept the dialogue stem with `--keep-stems`, so the check aligned words on the mix with music. Stems are now always kept, and `check` warns when it has to measure on the mix.
- **Shorts and cut-downs no longer end on the first syllable of the next sentence**: the air kept after a selection (350 ms) now stops before the next word. Two of three real Shorts ended on a clipped « entre » / « mais » captioned for 1–2 frames.
- **No more flash captions in fast speech**: a screen that would stay up less than `captions.minDurationMs` joins its neighbour, or the two are split again into readable screens (« OUI » · « ON VA VOIR » → « OUI ON » · « VA VOIR »), never across the end of a sentence.
- Windows: Studio served every file as 404 (path check with `/`); the OTIO test expected POSIX file URLs.

### Added
- **L-cuts at changes of rush** (`montage.sourceChangeLCutFrames`, 6 frames by default): the next rush's picture comes in before its sound, over the end of the previous line, the classic editor's transition. The sound is unchanged sample for sample (only the picture cut moves). Never on a jump cut (lips would be out of sync), never when the edit is cut to music, only where the next rush shows no speech in those frames. On a real two-rush interview: 1 L-cut, rule `montage.jl-cuts` evaluated for the first time (100 %), score 97.3/100.
- **QA rule `captions.reading-time`** (27 rules): each caption stays on screen at least the profile's minimum (±1 frame). It fails on the earlier Shorts (screens of 1–7 frames), passes on long-form edits.
- **`tutorial` profile with screen zoom**: on screen recordings, a new `activity` analyzer finds where the picture changes and the camera pushes in on it (1.6×, eased 0.6 s moves, framing held ≥ 2 s, confirmed targets only), pulls back on a change of window, never leaves the picture. QA 100/100 on a synthetic screen recording.
- Silent renders: loudness is reported as not evaluated instead of failing at -70 LUFS; every "not evaluated" note is translated.
- **`--broll-search "<query>"`**: free cutaways downloaded as 8 s excerpts (Pexels with `PEXELS_API_KEY`, else Wikimedia Commons, public domain / CC0 / CC BY only; CC BY-SA never by default since it would relicense the edit), credits in `credits.txt`.
- **Persistent analysis worker**: one Python process serves every task of a run, models stay loaded (`CUTKILLER_WORKER_MODE=oneshot` for the old behaviour); cached models load without contacting the Hub (9.2 s → 7.7 s per cold load). Quality check of a 54 s Short: 96.5 s → 89.5 s (-7 %).
- **`cutkiller studio`**: a local web page to edit by transcript — untick sentences, render, watch the result with its quality score and failed rules (no dependency, works on phones).
- **16 languages** with word alignment and hesitation removal (was 7): Polish, Russian, Arabic, Chinese, Japanese, Finnish, Greek, Hungarian and Persian added.
- **Riser → impact on changes of section**: two synthesized SFX (`riser@1`, `impact-boom@1`) land on the first cut of each editorial selection after the first (`profile.audio.sfx.sectionChange`, on in `short` and `long`); QA checks them against the cut (`syncTo: cut:<clip>`).
- **`--target <seconds>`** on `auto` / `plan`: a cut-down of a long video to its strongest sentences, strongest hook first (`--ai`: chosen by Claude).
- **Dialogue cleanup** before compression (`profile.audio.voiceCleanup`): 80 Hz high-pass on by default; adaptive denoising opt-in (`denoiseDb: 10`). Measured on speech with -40 dBFS pink noise: noise in the pauses -6.1 dB, voice -0.13 dB. Denoising is off by default because it softens word attacks: caption sync measured on clean speech moved from a 0.2 to a 0.75 frame median (p95 1.2 frames, over the 1-frame threshold).
- **`cutkiller shorts`** (and MCP `make_shorts`): one long recording → N Shorts that open on their strongest line, each edited, rendered, scored and ranked in `shorts.md`. Offline editorial planner by default; `--ai` lets Claude choose the clips (structured output, server-side fallbacks, offline fallback when unavailable).
- **Stage timings** (`ℹ [timing]`) for analysis workers, planning, render and QA, to measure where the time goes (`CUTKILLER_TIMINGS=0` hides them).
- **Multilingual editing**: spoken language detected per rush; hesitation lists, forced aligner and number spelling for English, French, Spanish, German, Italian, Portuguese and Dutch; `--lang` to force it.
- **Docker image** `ghcr.io/baldw1n69/cutkiller`: FFmpeg 6.1, Node, Python workers in one command.
- **`cutkiller doctor`**: checks FFmpeg, workers, canvas, models, GPU and memory, with the fix for each problem.
- **MCP server** (`cutkiller mcp`): auto_edit, plan_edit, read_edl, write_edl, render_edl, quality_check, export_timeline, list_styles, doctor.
- **Export to pro editors** (`cutkiller export`): OpenTimelineIO (`.otio`) and Final Cut Pro 7 XML (`.xml`) for DaVinci Resolve, Premiere Pro and Final Cut.
- **Claude Code plugin**: `video-editing` skill (edit → read the report → fix → render loop) and MCP configuration.
- **English messages and reports by default** (`CUTKILLER_LANG=fr` for French): CLI help, pipeline logs, edit notes, the 26 rule titles and thresholds, every QA and EDL validation message.
- **Documentation site** (GitHub Pages, MkDocs): getting started, AI agents, export, a quality-rule reference generated from code (`pnpm run docs:rules`, checked in CI).
- English README with a before/after demo; contributing guide, code of conduct, security policy, issue and PR templates.

### Changed
- Repository consolidated on the TypeScript + Python pipeline (formerly branch `lucid-knuth`), licensed Apache-2.0.

## [0.8.0] — 2026-11-18
Phases 0–8 of the original pipeline: EDL v1, cut/zoom cuts/beats, motion, karaoke captions, audio (-14 LUFS, ducking, SFX), 9:16 face tracking and skin matching, calibrated 26-rule QA, cinematic profiles, B-roll and looks. See `docs/phases/`.
