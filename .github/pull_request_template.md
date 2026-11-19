## What and why

## How it was checked
- [ ] `pnpm check && pnpm typecheck && pnpm test`
- [ ] Workers: `uv run ruff check . && uv run pytest` (if touched)
- [ ] Quality score before / after on a real or fixture edit (if the edit changes)
