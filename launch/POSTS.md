# Launch posts

Ready-to-post texts for the v1.0 launch. Every number comes from a measurement in this repo (README, `docs/BENCHMARK.md`); update them if they change. Post the GIF (`docs/media/demo.gif`) wherever images are allowed.

## Hacker News — Show HN

**Title:** Show HN: CutKiller – an open-source video editor that grades its own edits

**Text:**

I built CutKiller to edit talking-head footage the way an editor would, and to prove the result instead of hoping it's good.

`cutkiller auto interview.mp4 music.mp3 -p short` cuts silences, hesitations and false starts at word accuracy (Whisper + forced alignment, 16 languages), reframes 16:9 to 9:16 by following the face, adds word-by-word captions in the platforms' safe zones, mixes the voice to -14 LUFS with the music ducked, and snaps cuts to the beat.

Then it checks its own render against 26 measurable rules (loudness, true peak, caption sync to the frame, safe zones, contrast, jump cuts, face in frame…) and writes a report with timecodes. The QA is calibrated: for each rule, a defect is injected into a clean edit and must be caught.

Also: `cutkiller shorts` turns a long recording into ranked Shorts (offline, or Claude picks the clips with `--ai`), `cutkiller studio` lets you edit by transcript in the browser, an MCP server lets Claude/Cursor drive it, and it exports timelines to Premiere, DaVinci Resolve and Final Cut.

Honest limits: on a 4-core CPU it takes about 10 minutes for a 60 s Short (auto-editor does its silence cut in 7 s; benchmark in the repo). Apache-2.0, runs locally, one Docker command.

https://github.com/BaldW1N69/CutKiller

## Reddit — r/VideoEditing, r/NewTubers, r/selfhosted

**Title:** I made a free, local tool that turns raw interviews into Shorts and scores its own edit (open source)

**Body:**

Drop in your raw footage and a music file, get back a vertical Short with:
- silences, « um / uh » and false starts cut at the word
- the camera following your face (16:9 → 9:16)
- word-by-word captions inside TikTok/Reels safe zones
- voice at -14 LUFS, music ducked under speech, cuts on the beat

…and a quality report that tells you exactly what's still wrong, with timecodes (out of 26 rules).

It can also pull the best 5 Shorts out of a long podcast, give you a 60 s version of a 10 min video, or let you edit by unticking sentences in a transcript. Exports to Premiere / Resolve / Final Cut if you want to finish by hand.

Free, runs on your machine (Docker or source), Apache-2.0. It's slow on CPU (≈10 min for a 60 s Short), I'm working on it. Feedback very welcome, especially failed edits: the report's timecodes make them easy to reproduce.

https://github.com/BaldW1N69/CutKiller

## X / Threads

1/ I open-sourced CutKiller: raw footage in, publish-ready Short out, and a report that proves the edit is good (26 measured rules). 🧵

2/ It cuts silences and « um » at the word, follows your face for 9:16, captions word by word in the safe zones, mixes to -14 LUFS. [GIF]

3/ `cutkiller shorts podcast.mp4` → the 5 best Shorts, ranked by hook. `--ai` lets Claude choose them.

4/ Edit by transcript in your browser, or let Claude/Cursor drive it over MCP. Export to Premiere / Resolve / Final Cut.

5/ Free, local, Apache-2.0: https://github.com/BaldW1N69/CutKiller

## LinkedIn (FR)

J'ai publié CutKiller en open source : un monteur vidéo qui transforme des rushes bruts en Shorts, Reels ou vidéos YouTube prêts à publier, et qui **note son propre montage** sur 26 règles mesurables (son à -14 LUFS, sous-titres synchronisés à l'image près, cadrage du visage, zones sûres des plateformes…).

Ce qu'il fait :
- coupe les silences, les « euh » et les faux départs au mot près, en 16 langues ;
- recadre en 9:16 en suivant le visage, sous-titre mot à mot, mixe la voix et la musique ;
- extrait les meilleurs Shorts d'une vidéo longue, avec Claude en option ;
- exporte vers Premiere, DaVinci Resolve et Final Cut.

Gratuit, en local, licence Apache-2.0 : https://github.com/BaldW1N69/CutKiller

## Where to post, in order

1. Hacker News (Show HN), a weekday at 15:00–17:00 Paris time.
2. Reddit: r/VideoEditing, r/NewTubers, r/selfhosted, r/opensource (one per day, adapt the title).
3. X / Threads / LinkedIn with the GIF.
4. Product Hunt once the README GIF and docs site are live.
5. Pull requests to "awesome" lists: awesome-video, awesome-ffmpeg, awesome-mcp-servers, awesome-selfhosted.
