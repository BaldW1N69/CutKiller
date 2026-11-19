.PHONY: setup test demo
setup:
	python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
	cd studio && npm ci

test:
	.venv/bin/pytest -q

demo:
	.venv/bin/cutkiller demo --bpm 128
	.venv/bin/cutkiller cut demo/track-128.wav demo/footage-a.mp4 demo/footage-b.mp4 -o out/demo-cut.mp4
	.venv/bin/cutkiller motion demo/track-128.wav --title "CutKiller" --subtitle "on the beat" -o out/demo-motion.mp4
