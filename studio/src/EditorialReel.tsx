import { Audio, Video } from "@remotion/media";
import React from "react";
import { AbsoluteFill, Easing, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { beatProgress } from "./beat";
import { MONO, SANS } from "./fonts";
import type { ReelPlan, ReelShot } from "./types";

// 16:9 footage -> 9:16 editorial reel: the footage lives in a full-width panel,
// typography lives in the bars above/below (inside Instagram's safe zone).

const resolve = (src: string) => (/^https?:\/\//.test(src) ? src : staticFile(src));
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Shot: React.FC<{ shot: ReelShot; srcW: number; srcH: number; panelW: number; panelH: number; src: string; punch: number }> = ({
  shot, srcW, srcH, panelW, panelH, src, punch,
}) => {
  const frame = useCurrentFrame(); // local to the Sequence
  const { fps } = useVideoConfig();
  const z0 = shot.zoom ?? 1;
  const z1 = z0 + (shot.push ?? 0);
  const zoom =
    interpolate(frame, [0, shot.dur], [z0, z1], { ...clamp, easing: Easing.bezier(0.33, 0, 0.2, 1) }) * (1 + punch);
  const w = panelW * zoom;
  const h = panelH * zoom;
  const cx = ((shot.cx ?? srcW / 2) / srcW) * w;
  const cy = ((shot.cy ?? srcH / 2) / srcH) * h;
  const left = Math.min(0, Math.max(panelW - w, panelW / 2 - cx));
  const top = Math.min(0, Math.max(panelH - h, panelH / 2 - cy));
  return (
    <Video
      src={src}
      trimBefore={Math.round(shot.inSec * fps)}
      muted
      objectFit="cover"
      style={{ position: "absolute", width: w, height: h, left, top }}
    />
  );
};

const Typewriter: React.FC<{ text: string; from: number; dur: number; size: number; color: string }> = ({ text, from, dur, size, color }) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  if (local < 0 || local >= dur) return null;
  const chars = Math.min(text.length, Math.floor(local / 1.4));
  const cursorOn = Math.floor(local / 8) % 2 === 0;
  const out = interpolate(local, [dur - 6, dur], [1, 0], clamp);
  return (
    <div style={{ fontFamily: MONO, fontSize: size, color, letterSpacing: "0.02em", opacity: out, whiteSpace: "pre" }}>
      {text.slice(0, chars)}
      <span style={{ opacity: cursorOn ? 1 : 0 }}>▍</span>
    </div>
  );
};

export const EditorialReel: React.FC<ReelPlan> = (plan) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const { accent, name } = plan.brand;
  const bf = plan.beatFrames;
  const ink = "#F2F2F0";
  const bg = "#0B0B0C";
  const margin = Math.round(width * 0.055);

  const panelW = width;
  const panelH = Math.round((width * plan.video.height) / plan.video.width);
  const panelTop = Math.round((height - panelH) / 2 - height * 0.04);

  // downbeat punch (tiny, clean), stronger after the hero
  const downs = plan.beats.filter((b) => b % (bf * 4) < 0.5 || Math.abs((b % (bf * 4)) - bf * 4) < 0.5);
  const last = downs.filter((d) => d <= frame).pop();
  const punch =
    last === undefined ? 0 : interpolate(frame - last, [0, bf * 1.2], [frame >= plan.heroFrame ? 0.035 : 0.02, 0], clamp);

  // panel collapses into a line for the end card
  const collapse = interpolate(frame, [plan.endFrame - 2, plan.endFrame + 6], [1, 0], {
    ...clamp,
    easing: Easing.bezier(0.7, 0, 0.3, 1),
  });
  const shownH = Math.max(2, panelH * collapse);
  // ...then the line retracts to the centre and disappears before the wordmark lands
  const lineFrac = interpolate(frame, [plan.endFrame + 6, plan.endFrame + 12], [1, 0], {
    ...clamp,
    easing: Easing.bezier(0.7, 0, 0.3, 1),
  });

  // hero
  const heroIn = (i: number) => beatProgress(frame, plan.heroFrame + i * 0.12 * bf, 0.6, bf, Easing.bezier(0.16, 1, 0.3, 1));
  const scaleUp = beatProgress(frame, plan.scaleFrame, 0.75, bf, Easing.bezier(0.34, 1.56, 0.64, 1));
  const scan = interpolate(frame, [plan.heroFrame, plan.heroFrame + bf * 1.5], [0, 1], clamp);
  const tagNow = plan.tags.filter((t) => t.from <= frame).pop();
  const titleSize = Math.round(width * 0.19);
  const heroVisible = frame >= plan.heroFrame && frame < plan.endFrame;

  // end card
  const endIn = (i: number) => beatProgress(frame, plan.endFrame + 12 + i * 0.1 * bf, 0.8, bf, Easing.bezier(0.16, 1, 0.3, 1));
  const lineW = interpolate(frame, [plan.endFrame + 16, plan.endFrame + 16 + bf * 2], [0, width * 0.32], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const recOn = Math.floor(frame / (bf * 2)) % 2 === 0;

  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      {/* footage panel */}
      <div
        style={{
          position: "absolute",
          left: (panelW * (1 - lineFrac)) / 2,
          top: panelTop + (panelH - shownH) / 2,
          width: panelW * lineFrac,
          height: shownH,
          overflow: "hidden",
          backgroundColor: collapse < 1 ? ink : bg,
        }}
      >
        {collapse > 0.02 ? (
          <div style={{ position: "absolute", left: 0, top: -(panelH - shownH) / 2, width: panelW, height: panelH }}>
            {plan.shots.map((s, i) => (
              <Sequence key={i} name={s.tag ?? `shot ${i}`} from={s.from} durationInFrames={s.dur} premountFor={fps}>
                <Shot shot={s} srcW={plan.video.width} srcH={plan.video.height} panelW={panelW} panelH={panelH} src={resolve(plan.video.src)} punch={punch} />
              </Sequence>
            ))}
            {/* scan line on the hero beat */}
            {scan > 0 && scan < 1 ? (
              <div style={{ position: "absolute", left: 0, width: panelW, top: scan * panelH, height: 3, backgroundColor: accent, boxShadow: `0 0 18px ${accent}` }} />
            ) : null}
          </div>
        ) : null}
      </div>

      {/* top bar: wordmark + tag */}
      {frame < plan.endFrame ? (
        <div
          style={{
            position: "absolute",
            left: margin,
            right: margin,
            top: panelTop - width * 0.075,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontFamily: MONO,
            fontSize: width * 0.03,
            color: ink,
            letterSpacing: "0.18em",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: width * 0.018 }}>
            <div style={{ width: width * 0.016, height: width * 0.016, borderRadius: "50%", backgroundColor: accent, opacity: recOn ? 1 : 0.25 }} />
            {name}
          </div>
          <div style={{ opacity: 0.7 }}>{tagNow?.text ?? ""}</div>
        </div>
      ) : null}

      {/* bottom: captions before the hero, title after */}
      <div style={{ position: "absolute", left: margin, right: margin, top: panelTop + panelH + width * 0.06 }}>
        {plan.captions.map((c, i) => (
          <Typewriter key={i} text={c.text} from={c.from} dur={c.dur} size={width * 0.034} color={ink} />
        ))}
        {heroVisible ? (
          <div style={{ scale: 1 + 0.05 * scaleUp, transformOrigin: "left top" }}>
            <div style={{ display: "flex", overflow: "hidden", lineHeight: 1, paddingBottom: titleSize * 0.06 }}>
              {Array.from(name).map((ch, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    fontFamily: SANS,
                    fontWeight: 800,
                    fontSize: titleSize,
                    letterSpacing: "-0.045em",
                    color: ink,
                    translate: `0px ${(1 - heroIn(i)) * titleSize * 1.05}px`,
                  }}
                >
                  {ch}
                </span>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: width * 0.025,
                marginTop: width * 0.02,
                fontFamily: MONO,
                fontSize: width * 0.03,
                letterSpacing: "0.22em",
                color: ink,
                opacity: beatProgress(frame, plan.scaleFrame, 1, bf),
              }}
            >
              <div style={{ width: width * 0.08 * beatProgress(frame, plan.scaleFrame, 1, bf), height: 3, backgroundColor: accent }} />
              {plan.brand.tagline}
            </div>
          </div>
        ) : null}
      </div>

      {/* end card */}
      {frame >= plan.endFrame ? (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
          <div style={{ display: "flex", overflow: "hidden", lineHeight: 1, paddingBottom: titleSize * 0.06 }}>
            {Array.from(name).map((ch, i) => (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  fontFamily: SANS,
                  fontWeight: 800,
                  fontSize: titleSize * 1.05,
                  letterSpacing: "-0.045em",
                  color: ink,
                  translate: `0px ${(1 - endIn(i)) * titleSize * 1.1}px`,
                }}
              >
                {ch}
              </span>
            ))}
          </div>
          <div style={{ width: lineW, height: 4, backgroundColor: accent, marginTop: width * 0.03 }} />
        </AbsoluteFill>
      ) : null}

      {plan.audio.src ? <Audio src={resolve(plan.audio.src)} trimBefore={Math.round(plan.audio.startSec * fps)} /> : null}
    </AbsoluteFill>
  );
};
