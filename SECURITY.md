# Security policy

CutKiller runs locally and processes media files with FFmpeg and Python workers. Treat untrusted media and untrusted EDL/profile files with the same care as any input to FFmpeg.

## Reporting a vulnerability

Please **do not open a public issue**. Use [GitHub private vulnerability reporting](https://github.com/BaldW1N69/CutKiller/security/advisories/new). We aim to acknowledge reports within 72 hours.

## Supported versions

The latest release and `main` receive fixes.

## Running CutKiller for other people (shared service)

On your own machine, CutKiller trusts you: it opens the files you name. When others can send it media, EDLs or agent requests (Studio or the MCP server reachable by them, a render queue), turn on the protections below. The audit behind them is in [`docs/security/AUDIT-2026-11-20.md`](docs/security/AUDIT-2026-11-20.md).

| Protection | On by default | What it stops |
|---|---|---|
| FFmpeg input allow-lists (`-protocol_whitelist file,pipe`, self-contained media formats only) | yes | A playlist (`.m3u8`) or concat list sent as a "video" making FFmpeg read other files of the machine into the render |
| `CUTKILLER_WORKSPACE=/srv/jobs` | **no — set it** | Any path outside that folder (rushes, EDL sources, outputs, every MCP argument), `..` and symlinks included. `read_edl` only ever returns a valid EDL |
| EDL limits (4096 px per side, 120 fps, 400 Mbps, 4 h, bounded collections) | yes | Renders that exhaust memory, disk or CPU |
| Studio session key, Host and Origin checks, JSON-only API | yes | Other websites starting renders (CSRF) or reading your transcripts and videos (DNS rebinding) |
| Third-party downloads: https only, public addresses only, every redirect checked, size cap | yes | Requests to this machine, its network or a cloud metadata service (SSRF) |
| Docker image runs as an unprivileged user | yes | A decoder flaw reached through a crafted file running as root |

Still your job when exposing it: put Studio behind your own authentication and TLS (it listens on 127.0.0.1 only), run each job in its own container without network and with CPU/memory limits (the only real barrier against an unknown FFmpeg flaw), and keep FFmpeg up to date.
