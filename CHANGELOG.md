# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Multilingual editing**: spoken language detected per rush; hesitation lists, forced aligner and number spelling for English, French, Spanish, German, Italian, Portuguese and Dutch; `--lang` to force it.
- **Docker image** `ghcr.io/baldw1n69/cutkiller`: FFmpeg 6.1, Node, Python workers in one command.
- **`cutkiller doctor`**: checks FFmpeg, workers, canvas, models, GPU and memory, with the fix for each problem.
- **MCP server** (`cutkiller mcp`): auto_edit, plan_edit, read_edl, write_edl, render_edl, quality_check, export_timeline, list_styles, doctor.
- **Export to pro editors** (`cutkiller export`): OpenTimelineIO (`.otio`) and Final Cut Pro 7 XML (`.xml`) for DaVinci Resolve, Premiere Pro and Final Cut.
- **Claude Code plugin**: `video-editing` skill (edit → read the report → fix → render loop) and MCP configuration.
- **English messages and reports by default** (`CUTKILLER_LANG=fr` for French): CLI help, pipeline logs, edit notes, the 26 rule titles and thresholds, every QA and EDL validation message.
- **Documentation site** (GitHub Pages, MkDocs): getting started, AI agents, export, a quality-rule reference generated from code (`pnpm docs`, checked in CI).
- English README with a before/after demo; contributing guide, code of conduct, security policy, issue and PR templates.

### Changed
- Repository consolidated on the TypeScript + Python pipeline (formerly branch `lucid-knuth`), licensed Apache-2.0.

## [0.8.0] — 2026-11-18
Phases 0–8 of the original pipeline: EDL v1, cut/zoom cuts/beats, motion, karaoke captions, audio (-14 LUFS, ducking, SFX), 9:16 face tracking and skin matching, calibrated 26-rule QA, cinematic profiles, B-roll and looks. See `docs/phases/`.
