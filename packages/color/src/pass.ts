import {
  type Diagnostic,
  type Edl,
  EdlSchema,
  type Pass,
  type Subjects,
  tr,
  type VideoClip,
} from "@cutkiller/core";

import { lightnessToY, linearToSrgb, lumaLinear, type Rgb, srgbToLab, srgbToLinear } from "./lab";

export const toLinear = (rgb: Rgb): Rgb => rgb.map((v) => Math.max(1e-4, srgbToLinear(v))) as Rgb;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

/**
 * Skin colour of a source between two times: per-channel median of the largest
 * face's centre patch, when faces are seen in at least `minShare` of the samples.
 */
export function skinTone(subjects: Subjects, from: number, to: number, minShare = 0.3): Rgb | undefined {
  const inside = subjects.samples.filter((s) => s.t >= from - 1e-6 && s.t <= to + 1e-6);
  const skins = inside.flatMap((s) =>
    s.faces.length === 0 ? [] : [s.faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b)).rgb],
  );
  if (inside.length === 0 || skins.length < Math.max(1, minShare * inside.length)) return undefined;
  return [0, 1, 2].map((c) => median(skins.map((rgb) => rgb[c] as number))) as Rgb;
}

/**
 * Passe « color » : l'exposition et la balance des blancs de chaque source (caméra,
 * prise) sont ramenées sur la teinte de peau de référence du montage (médiane
 * pondérée par la durée) ; un plan dont la peau s'écarte nettement de sa source est
 * raccordé isolément. Le look du profil (LUT générée) s'applique ensuite à tous
 * les plans. Une référence sous-exposée (visage à contre-jour) est relevée jusqu'à
 * une luminosité de peau plancher, les hautes lumières étant compressées au rendu.
 */
export const colorPass: Pass = {
  id: "color",
  run(edl: Edl, ctx) {
    const cfg = ctx.profile.color;
    const diagnostics: Diagnostic[] = [];
    if (!cfg.enabled) return { edl, diagnostics };
    const preset = ctx.presets?.resolve(cfg.look);
    const look = preset ? `${preset.name}@${preset.version}` : undefined;

    // Skin tone per source (one camera, one take): every shot of a source gets the
    // same correction, so jump cuts within a take never flicker. Measured over the
    // parts of the source the edit keeps.
    const tones = new Map<string, Rgb>();
    const bySource = new Map<string, VideoClip[]>();
    // B-roll shows other people in other places: it keeps its own skin (look and
    // scene contrast only); the speech shots are matched together.
    for (const clip of edl.video[0]?.clips ?? [])
      if (clip.why?.kind !== "broll") bySource.set(clip.source, [...(bySource.get(clip.source) ?? []), clip]);
    for (const [source, clips] of bySource) {
      const subjects = ctx.analysis.subjects?.[source];
      if (!subjects) continue;
      const kept = {
        ...subjects,
        samples: subjects.samples.filter((s) => clips.some((c) => s.t >= c.in - 1e-6 && s.t <= c.out + 1e-6)),
      };
      const tone = skinTone(kept, 0, Number.POSITIVE_INFINITY);
      if (tone) for (const clip of clips) tones.set(clip.id, toLinear(tone));
    }
    // Reference: per-channel median over clips, weighted by duration.
    let reference: Rgb | undefined;
    if (tones.size > 0) {
      const weighted: Rgb[] = [];
      for (const clip of (edl.video[0]?.clips ?? []).filter((c) => c.why?.kind !== "broll")) {
        const t = tones.get(clip.id);
        if (t) for (let i = 0; i < Math.max(1, Math.round((clip.out - clip.in) * 10)); i++) weighted.push(t);
      }
      reference = [0, 1, 2].map((c) => median(weighted.map((t) => t[c] as number))) as Rgb;
    }
    // Shot match: a shot whose own skin (≥ 3 samples) is visibly off its source's
    // (light changed, head turned to the window) gets its own correction, like a
    // colourist matching an outlier; the other shots keep the source's.
    let matched = 0;
    for (const [source, clips] of bySource) {
      const subjects = ctx.analysis.subjects?.[source];
      const base = clips[0] ? tones.get(clips[0].id) : undefined;
      if (!subjects || !base) continue;
      const baseLab = srgbToLab(base.map(linearToSrgb) as Rgb);
      for (const clip of clips) {
        const skins = subjects.samples.flatMap((x) =>
          x.t >= clip.in - 1e-6 && x.t <= clip.out + 1e-6 && x.faces.length > 0
            ? [x.faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b)).rgb]
            : [],
        );
        if (skins.length < 3) continue;
        const own = [0, 1, 2].map((c) => median(skins.map((rgb) => rgb[c] as number))) as Rgb;
        const lab = srgbToLab(own);
        if (Math.hypot(lab[0] - baseLab[0], lab[1] - baseLab[1], lab[2] - baseLab[2]) > cfg.shotMatchDeltaE) {
          tones.set(clip.id, toLinear(own));
          matched++;
        }
      }
    }
    // B-roll scenes: shots of one rush matched to the scene's own skin (median over
    // its shots) when one is visibly off (the person stepped into the shade); never
    // to the speaker's skin, which belongs to someone else.
    const targets = new Map<string, Rgb>();
    const brollBySource = new Map<string, VideoClip[]>();
    for (const clip of edl.video[0]?.clips ?? [])
      if (clip.why?.kind === "broll")
        brollBySource.set(clip.source, [...(brollBySource.get(clip.source) ?? []), clip]);
    for (const [source, clips] of brollBySource) {
      const subjects = ctx.analysis.subjects?.[source];
      if (!subjects) continue;
      const own = clips.flatMap((clip) => {
        const skins = subjects.samples.flatMap((x) =>
          x.t >= clip.in - 1e-6 && x.t <= clip.out + 1e-6 && x.faces.length > 0
            ? [x.faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b)).rgb]
            : [],
        );
        if (skins.length < 3) return [];
        return [{ clip, skin: [0, 1, 2].map((c) => median(skins.map((rgb) => rgb[c] as number))) as Rgb }];
      });
      if (own.length < 2) continue;
      const scene = [0, 1, 2].map((c) => median(own.map((o) => o.skin[c] as number))) as Rgb;
      const sceneLab = srgbToLab(scene);
      for (const o of own) {
        const lab = srgbToLab(o.skin);
        if (
          Math.hypot(lab[0] - sceneLab[0], lab[1] - sceneLab[1], lab[2] - sceneLab[2]) > cfg.shotMatchDeltaE
        ) {
          tones.set(o.clip.id, toLinear(o.skin));
          targets.set(o.clip.id, toLinear(scene));
          matched++;
        }
      }
    }

    // Floor: a reference skin darker than L* minSkinLightness is lifted (all shots alike).
    let lift = 0;
    if (reference) {
      const lightness = srgbToLab(reference.map(linearToSrgb) as Rgb)[0];
      if (lightness < cfg.minSkinLightness)
        lift = Math.log2(lightnessToY(cfg.minSkinLightness) / lumaLinear(reference));
    }

    // Scene contrast: per source, from its tonal range over the kept samples.
    const sceneContrast = new Map<string, number>();
    const sc = cfg.sceneContrast;
    if (sc.enabled) {
      const all = edl.video.flatMap((t) => t.clips);
      for (const source of new Set(all.map((c) => c.source))) {
        const clips = all.filter((c) => c.source === source);
        const spans = (ctx.analysis.subjects?.[source]?.samples ?? []).flatMap((x) =>
          x.luma && clips.some((c) => x.t >= c.in - 1e-6 && x.t <= c.out + 1e-6)
            ? [x.luma[2] - x.luma[0]]
            : [],
        );
        if (spans.length < 3) continue;
        const span = Math.max(0.05, median(spans));
        const adj = Math.max(-sc.max, Math.min(sc.max, sc.strength * (sc.targetRange / span - 1)));
        if (Math.abs(adj) >= 0.02) sceneContrast.set(source, Math.round(adj * 1000) / 1000);
      }
    }

    let corrected = 0;
    const video = edl.video.map((track) => ({
      ...track,
      clips: track.clips.map((clip): VideoClip => {
        const tone = tones.get(clip.id);
        const target = targets.get(clip.id) ?? reference;
        let exposureEv = 0;
        let balance: Rgb = [1, 1, 1];
        if (tone && target && (reference || targets.has(clip.id))) {
          const ev = Math.log2(lumaLinear(target) / lumaLinear(tone)) + (targets.has(clip.id) ? 0 : lift);
          exposureEv =
            Math.abs(ev) < cfg.minCorrection
              ? 0
              : Math.max(-cfg.maxExposureEv, Math.min(cfg.maxExposureEv, ev));
          const ref = target;
          const gains = [0, 1, 2].map((c) => (ref[c] as number) / (tone[c] as number)) as Rgb;
          // Balance keeps the skin's luminance (exposure carries it): balance × 2^EV = gains.
          const norm = lumaLinear(gains.map((g, c) => g * (tone[c] as number)) as Rgb) / lumaLinear(tone);
          const exact = gains.map((g) => g / norm);
          // A cast is corrected on all channels or none (a partial correction shifts the hue).
          if (exact.some((b) => Math.abs(b - 1) >= cfg.minCorrection))
            balance = exact.map(
              (b) => Math.round(Math.max(1 - cfg.maxBalance, Math.min(1 + cfg.maxBalance, b)) * 1e4) / 1e4,
            ) as Rgb;
          exposureEv = Math.round(exposureEv * 1e3) / 1e3;
          if (exposureEv !== 0 || balance.some((b) => b !== 1)) corrected++;
        }
        return {
          ...clip,
          color: {
            exposureEv,
            balance,
            ...(look ? { look } : {}),
            ...(look && sceneContrast.has(clip.source) ? { contrast: sceneContrast.get(clip.source) } : {}),
            why: { kind: tone ? "skin-match" : "look-only" },
          },
        };
      }),
    }));
    diagnostics.push({
      level: "info",
      code: "color.summary",
      message: tr(
        `${corrected} shot(s) matched to the reference skin (${bySource.size} source(s), ${matched} shot(s) matched on their own${lift > 0 ? `, lifted ${lift.toFixed(2)} EV` : ""}), look ${look ?? "none"}${sceneContrast.size > 0 ? `, contrast adapted on ${sceneContrast.size} scene(s)` : ""}`,
        `${corrected} plan(s) corrigé(s) sur la peau de référence (${bySource.size} source(s), ${matched} plan(s) raccordé(s) isolément${lift > 0 ? `, relevée de ${lift.toFixed(2)} EV` : ""}), look ${look ?? "aucun"}${sceneContrast.size > 0 ? `, contraste adapté sur ${sceneContrast.size} scène(s)` : ""}`,
      ),
    });
    return { edl: EdlSchema.parse({ ...edl, video }), diagnostics };
  },
};
