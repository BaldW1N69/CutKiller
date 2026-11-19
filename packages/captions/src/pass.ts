import { type Diagnostic, type Edl, EdlSchema, edlDurationFrames, type Pass, tr } from "@cutkiller/core";
import { buildCaptions } from "./chunk";
import { profileSafeArea } from "./layout";
import { captionStyle } from "./style";
import { timelineWords } from "./words";

/**
 * Passe « captions » : sous-titres incrustés, synchronisés au mot (karaoké), découpés
 * selon le profil (1–3 mots en court, 2 lignes × 32 caractères en long), dans le style
 * de preset du profil.
 */
export const captionsPass: Pass = {
  id: "captions",
  run(edl: Edl, ctx) {
    const c = ctx.profile.captions;
    const diagnostics: Diagnostic[] = [];
    if (!c.enabled) return { edl, diagnostics };
    if (!ctx.presets) throw new Error("la passe captions a besoin du registre de presets");
    const words = timelineWords(edl, ctx.analysis.transcripts);
    if (words.length === 0) return { edl, diagnostics };
    const style = captionStyle(ctx.presets, c.style);
    const preset = ctx.presets.resolve(c.style);
    const captions = buildCaptions(
      words,
      style,
      `${preset.name}@${preset.version}`,
      ctx.profile,
      edl.output.fps,
      edlDurationFrames(edl),
    );
    diagnostics.push({
      level: "info",
      code: "captions.summary",
      message: tr(
        `${captions.length} caption screen(s), ${words.length} word(s), style ${preset.name}@${preset.version}`,
        `${captions.length} sous-titre(s), ${words.length} mot(s), style ${preset.name}@${preset.version}`,
      ),
    });
    const output = {
      ...edl.output,
      captions: { safeArea: profileSafeArea(ctx.profile), placement: c.placement },
    };
    return { edl: EdlSchema.parse({ ...edl, output, captions }), diagnostics };
  },
};
