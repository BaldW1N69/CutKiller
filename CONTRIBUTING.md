# Contributing to CutKiller

Thanks for helping! CutKiller has one rule above all: **every editing decision is measurable**. A change that makes edits better should show it in the quality report or in a test.

## Setup

```sh
pnpm install && (cd workers && uv sync)
pnpm fixtures          # synthetic media with ground truth (needs espeak-ng and FFmpeg 6+)
pnpm cutkiller doctor
```

## Before you open a pull request

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run ruff check . && uv run ruff format --check . && uv run pytest)
pnpm schema && git diff --exit-code schema   # if you touched the EDL, profile or report types
```

- **Thresholds live in profiles** (`profiles/*.yaml`, `packages/core/src/profile.ts`), never in code.
- **Planning passes are pure** `EDL → EDL` functions; side effects belong to `analyze`, `render` and `qa`.
- **A new QA rule** needs a calibration case (`packages/cli/src/calibrate.ts`): one injected defect that it must catch and a clean control it must accept.
- **A new language**: one entry in `workers/cutkiller_workers/languages.py` and one in `packages/core/src/lexicon.ts`.
- **Third-party code or assets**: record the licence in `LICENSES.md` before adding them.
- Keep commits focused, with a message that says why.

## Good first issues

Look for the `good first issue` label: hesitation lists for a new language, a new look preset, a new caption style, docs translations.

## Reporting a bad edit

Open an issue with the `quality.md` report and, if you can share it, a short clip. The report's timecodes are what lets us reproduce it.
