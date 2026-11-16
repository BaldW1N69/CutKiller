# Connexion CutKiller ↔ DaVinci Resolve

`cutkiller_bridge.py` se connecte à Resolve, vérifie la liaison et exporte l'état du projet ouvert (timelines, pistes, clips, marqueurs) en JSON.

## Option A — Depuis Resolve (marche avec la version gratuite)

1. Copier `cutkiller_bridge.py` dans le dossier Scripts :
   - **Windows** : `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\`
   - **macOS** : `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/`
   - **Linux** : `~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/`
2. Ouvrir un projet dans Resolve → **Workspace > Scripts > Utility > cutkiller_bridge**.
3. Résultat : `cutkiller_resolve_state.json` dans ton dossier utilisateur. La console (Workspace > Console) affiche `[OK] Connecté…`.

> Les scripts Lua de X-Raym (`DaVinci-Resolve-Scripts`) s'installent au même endroit.

## Option B — Depuis un terminal (Resolve Studio requis)

1. Resolve : **Preferences > System > General > External scripting using = Local**.
2. Resolve ouvert avec un projet, puis :

```bash
python3 resolve/cutkiller_bridge.py --json state.json
```

Si le module n'est pas trouvé, définir `RESOLVE_SCRIPT_API` vers le dossier `Developer/Scripting` de ton installation.

## Option C — Laisser l'agent piloter Resolve en direct

L'agent CutKiller tourne dans le cloud et ne voit pas ta machine. Deux façons de lui donner la main :

- **Session locale** : lancer Claude Code sur ton PC (app Claude Desktop, ou `claude remote-control` dans le dossier du projet). L'agent exécute alors ce script lui-même.
- **Filmit** : ouvrir le panneau Filmit dans ton logiciel de montage → onglet **MCP** → **Connect**. L'agent obtient les outils `dv_*` (timelines, clips, marqueurs, export).
