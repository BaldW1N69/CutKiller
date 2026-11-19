/**
 * Style fingerprint of a finished video — rhythm, image, sound — measured the
 * same way on a reference the user likes and on a CutKiller render, so that
 * "does it look like what I expect?" becomes a table of numbers, with the profile
 * settings to move when they differ.
 */
import { ffmpeg, ffprobe, measureLoudness, parseRate } from "@cutkiller/media";

export interface Fingerprint {
  video: string;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  /** Rhythm: cuts found by scene change (picture difference > threshold). */
  cuts: number;
  shotMeanS: number;
  shotMedianS: number;
  cutsPerMin: number;
  /** Share of shots shorter than 1 s (flash cuts). */
  flashShare: number;
  /** Image (8-bit levels, 2 samples/s): mean luma, p10–p90 span, mean saturation, warmth (Cr − Cb). */
  luma: number;
  contrast: number;
  saturation: number;
  warmth: number;
  /** Letterbox: share of the height covered by black bars. */
  letterbox: number;
  /** Sound. */
  lufs: number;
  lra: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor(s.length / 2)] as number);
};
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Times (s) where the picture changes enough to be a cut. */
async function sceneCuts(video: string, threshold: number): Promise<number[]> {
  const { stderr } = await ffmpeg([
    "-hide_banner",
    "-i",
    video,
    "-map",
    "0:v:0",
    "-vf",
    `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

async function pictureStats(video: string) {
  const { stdout } = await ffmpeg([
    "-hide_banner",
    "-v",
    "error",
    "-i",
    video,
    "-map",
    "0:v:0",
    "-vf",
    "fps=2,scale=320:-2,signalstats,metadata=print:file=-",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const text = stdout.toString();
  const values = (key: string) =>
    [...text.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const ylow = values("YLOW");
  const yhigh = values("YHIGH");
  const u = values("UAVG");
  const v = values("VAVG");
  return {
    luma: mean(values("YAVG")),
    contrast: mean(yhigh.map((h, i) => h - (ylow[i] ?? 0))),
    saturation: mean(values("SATAVG")),
    warmth: mean(v.map((x, i) => x - (u[i] ?? 128))),
  };
}

async function letterboxShare(video: string, height: number): Promise<number> {
  const { stderr } = await ffmpeg([
    "-hide_banner",
    "-i",
    video,
    "-map",
    "0:v:0",
    "-vf",
    "fps=1,cropdetect=limit=24:round=2:reset=0",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const crops = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => Number(m[2]));
  const kept = crops.at(-1) ?? height;
  return Math.max(0, Math.round(((height - kept) / height) * 1000) / 1000);
}

/** Rhythm, image and sound of a finished video. */
export async function fingerprint(video: string, sceneThreshold = 0.3): Promise<Fingerprint> {
  const info = await ffprobe(video);
  const v = info.streams.find((s) => s.codec_type === "video");
  const durationS = Number(info.format.duration ?? 0);
  const width = v?.width ?? 0;
  const height = v?.height ?? 0;
  const cuts = (await sceneCuts(video, sceneThreshold)).filter((t) => t > 0.05 && t < durationS - 0.05);
  const bounds = [0, ...cuts, durationS];
  const shots = bounds.slice(1).map((t, i) => t - (bounds[i] as number));
  const pic = await pictureStats(video);
  const hasAudio = info.streams.some((s) => s.codec_type === "audio");
  const loud = hasAudio ? await measureLoudness(video) : undefined;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    video,
    durationS: r2(durationS),
    width,
    height,
    fps: r2(parseRate(v?.avg_frame_rate) ?? 0),
    cuts: cuts.length,
    shotMeanS: r2(mean(shots)),
    shotMedianS: r2(median(shots)),
    cutsPerMin: r2((cuts.length / Math.max(durationS, 1e-6)) * 60),
    flashShare: r2(shots.filter((s) => s < 1).length / Math.max(1, shots.length)),
    luma: r2(pic.luma),
    contrast: r2(pic.contrast),
    saturation: r2(pic.saturation),
    warmth: r2(pic.warmth),
    letterbox: await letterboxShare(video, height),
    lufs: loud ? r2(loud.integrated) : Number.NaN,
    lra: loud ? r2(loud.range) : Number.NaN,
  };
}

export interface Comparison {
  metric: string;
  reference: number;
  ours: number;
  ok: boolean;
  /** What to change in the profile when it does not match. */
  advice?: string;
}

/**
 * Our render against a reference, metric by metric, with tolerances an editor
 * would not notice (shot length within ×1.5, contrast within 15 levels, saturation
 * within ×1.33, warmth within 5 levels, loudness within 2 LU).
 */
export function compareFingerprints(ref: Fingerprint, ours: Fingerprint): Comparison[] {
  const ratio = (a: number, b: number) => (b === 0 ? (a === 0 ? 1 : Number.POSITIVE_INFINITY) : a / b);
  const rows: Comparison[] = [];
  const add = (metric: string, r: number, o: number, ok: boolean, advice: string) =>
    rows.push({ metric, reference: r, ours: o, ok, ...(ok ? {} : { advice }) });
  const shot = ratio(ours.shotMedianS, ref.shotMedianS);
  add(
    "durée médiane d'un plan (s)",
    ref.shotMedianS,
    ours.shotMedianS,
    shot >= 2 / 3 && shot <= 1.5,
    shot > 1
      ? `plans trop longs : montage.maxStaticShotS ≈ ${Math.max(1, Math.round(ref.shotMedianS * 2 * 10) / 10)} s, broll.shotS plus courts`
      : `plans trop courts : montage.maxStaticShotS ≈ ${Math.round(ref.shotMedianS * 2 * 10) / 10} s, moins de zoom-cuts`,
  );
  const pace = ratio(ours.cutsPerMin, ref.cutsPerMin);
  add(
    "coupes par minute",
    ref.cutsPerMin,
    ours.cutsPerMin,
    pace >= 2 / 3 && pace <= 1.5,
    pace < 1 ? "rythme plus lent que la référence" : "rythme plus rapide que la référence",
  );
  add(
    "contraste (p90 − p10, niveaux)",
    ref.contrast,
    ours.contrast,
    Math.abs(ours.contrast - ref.contrast) <= 15,
    ours.contrast < ref.contrast
      ? "image plus plate : look plus contrasté (contrast), ou color.sceneContrast.targetRange plus haut"
      : "image plus dure : look moins contrasté",
  );
  const sat = ratio(ours.saturation, ref.saturation);
  add(
    "saturation moyenne",
    ref.saturation,
    ours.saturation,
    sat >= 0.75 && sat <= 4 / 3,
    sat < 1
      ? "moins saturé que la référence : saturation du look plus haute"
      : "plus saturé : saturation du look plus basse",
  );
  add(
    "chaleur (Cr − Cb)",
    ref.warmth,
    ours.warmth,
    Math.abs(ours.warmth - ref.warmth) <= 5,
    ours.warmth < ref.warmth
      ? "plus froid : warmth / highlightTint plus chauds"
      : "plus chaud : warmth plus bas",
  );
  add(
    "luminosité moyenne",
    ref.luma,
    ours.luma,
    Math.abs(ours.luma - ref.luma) <= 20,
    ours.luma < ref.luma
      ? "plus sombre : moins de vignette, lift plus haut"
      : "plus clair : vignette, lift plus bas",
  );
  add(
    "letterbox (part de la hauteur)",
    ref.letterbox,
    ours.letterbox,
    ref.letterbox > 0.05 === ours.letterbox > 0.05,
    ref.letterbox > 0.05
      ? `ajouter texture.letterbox (≈ ${(ref.width / (ref.height * (1 - ref.letterbox))).toFixed(2)})`
      : "retirer texture.letterbox",
  );
  if (Number.isFinite(ref.lufs) && Number.isFinite(ours.lufs))
    add(
      "loudness intégrée (LUFS)",
      ref.lufs,
      ours.lufs,
      Math.abs(ours.lufs - ref.lufs) <= 2,
      `audio.integratedLufs ≈ ${Math.round(ref.lufs)}`,
    );
  return rows;
}

export function fingerprintMarkdown(ref: Fingerprint, ours?: Fingerprint): string {
  const lines = [`# Référence : ${ref.video}`, ""];
  const fmt = (f: Fingerprint) =>
    [
      `${f.width}×${f.height}, ${f.fps} fps, ${f.durationS} s`,
      `${f.cuts} coupes, ${f.cutsPerMin} / min, plan médian ${f.shotMedianS} s (moyen ${f.shotMeanS} s), ${Math.round(f.flashShare * 100)} % de plans < 1 s`,
      `luma ${f.luma}, contraste ${f.contrast}, saturation ${f.saturation}, chaleur ${f.warmth}, letterbox ${Math.round(f.letterbox * 100)} %`,
      `${f.lufs} LUFS, LRA ${f.lra} LU`,
    ].map((l) => `- ${l}`);
  lines.push(...fmt(ref));
  if (ours) {
    const rows = compareFingerprints(ref, ours);
    lines.push(
      "",
      `## Comparaison avec ${ours.video}`,
      "",
      "| Mesure | Référence | CutKiller | Écart | À régler |",
      "|---|---|---|---|---|",
    );
    for (const r of rows)
      lines.push(`| ${r.metric} | ${r.reference} | ${r.ours} | ${r.ok ? "✅" : "❌"} | ${r.advice ?? ""} |`);
    const ok = rows.filter((r) => r.ok).length;
    lines.push("", `**${ok}/${rows.length} mesures dans la tolérance.**`);
  }
  return `${lines.join("\n")}\n`;
}
