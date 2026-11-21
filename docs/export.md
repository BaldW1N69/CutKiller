# Export to Premiere / Resolve / Final Cut

CutKiller does the tedious part; an editor can finish by hand in their own tool.

```sh
cutkiller export out/edit.edl.json -o edit.xml    # Premiere Pro, DaVinci Resolve, Final Cut (FCP7 XML)
cutkiller export out/edit.edl.json -o edit.otio   # DaVinci Resolve, Avid, OpenTimelineIO tools
```

| Travels | Does not travel |
|---|---|
| Every cut of every video track, frame-accurate | Animated keyframes (punch-in animations, transitions) |
| The rushes' audio under the main track | Grading and looks |
| Music clips with their gain | Burnt-in captions → import `final.srt` instead |
| Static punch-ins (scale) | Synthesized SFX (a marker at each impact instead) |
| One marker per edit decision (« cut before: « um » (filler) ») | |

Media are referenced by absolute `file://` paths: open the timeline on the machine that holds the rushes, or relink.

The `.otio` output is checked in CI by the reference implementation ([opentimelineio](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)); the `.xml` by an XML parser. Import in each application is tested by hand — please [report](https://github.com/BaldW1N69/CutKiller/issues) any import problem with the file attached.
