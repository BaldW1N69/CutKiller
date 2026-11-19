import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Fonts are vendored in public/fonts (OFL) so renders are offline and reproducible.
export const SERIF = "Fraunces";
export const SANS = "Inter";
export const MONO = "JetBrains Mono";

loadFont({ family: SERIF, url: staticFile("fonts/Fraunces-latin.woff2"), weight: "100 900" });
loadFont({ family: SANS, url: staticFile("fonts/Inter-latin.woff2"), weight: "100 900" });
loadFont({ family: MONO, url: staticFile("fonts/JetBrainsMono-latin.woff2"), weight: "100 800" });
