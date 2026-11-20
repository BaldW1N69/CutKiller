# AI agents (MCP)

CutKiller ships an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor, Codex or any MCP client can edit videos, read the quality report, fix the EDL and render again.

## Connect

=== "Claude Code (plugin)"

    ```sh
    claude plugin marketplace add BaldW1N69/CutKiller
    claude plugin install cutkiller@cutkiller
    ```

    The plugin adds the `video-editing` skill (the edit → report → fix → render loop) and the MCP server (Docker).

=== "Any MCP client (Docker)"

    ```json
    {
      "mcpServers": {
        "cutkiller": {
          "command": "docker",
          "args": ["run", "-i", "--rm", "-v", "/path/to/videos:/work", "-v", "cutkiller-models:/models",
                   "ghcr.io/baldw1n69/cutkiller:latest", "mcp"]
        }
      }
    }
    ```

=== "From source"

    ```sh
    claude mcp add cutkiller -- pnpm --dir /path/to/CutKiller --silent cutkiller mcp
    ```

## Tools

| Tool | What it does |
|---|---|
| `auto_edit` | Analyse, plan, render and score in one call; returns the score and every failed rule |
| `plan_edit` | Write the editable EDL without rendering |
| `read_edl` / `write_edl` | Read the EDL; validate and save an edited one (refused if invalid) |
| `render_edl` | Render an EDL (draft or final) |
| `quality_check` | Score a video on the 27 rules |
| `export_timeline` | `.otio` / `.xml` for Premiere Pro, DaVinci Resolve, Final Cut |
| `list_styles` | Profiles, looks and supported languages |
| `doctor` | Installation check with fixes |

With Docker, paths are inside the container: use paths relative to the mounted folder.
