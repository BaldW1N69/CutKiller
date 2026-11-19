import { Audio } from "@remotion/media";
import React from "react";
import { AbsoluteFill, Easing, interpolate, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { beatProgress, pulse } from "./beat";
import { SANS as sans, SERIF as serif } from "./fonts";
import type { MotionPlan } from "./types";


const resolve = (src: string) => (/^https?:\/\//.test(src) ? src : staticFile(src));

// Feel = how motion is eased. Durations are in BEATS, so tempo already sets the pace:
// the same design breathes at 72 BPM and snaps at 128 BPM.
const FEEL = {
  airy: { reveal: 3, letter: 1, scale: 1.5, ease: Easing.bezier(0.25, 0.1, 0.25, 1), pop: Easing.bezier(0.33, 1, 0.68, 1) },
  punchy: { reveal: 2, letter: 0.5, scale: 0.75, ease: Easing.bezier(0.16, 1, 0.3, 1), pop: Easing.bezier(0.34, 1.56, 0.64, 1) },
};

const Paper: React.FC<{ color: string }> = ({ color }) => (
  <AbsoluteFill style={{ backgroundColor: color }}>
    <svg width="100%" height="100%" style={{ position: "absolute", mixBlendMode: "multiply", opacity: 0.5 }}>
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="3" stitchTiles="stitch" />
        <feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.38  0 0 0 0 0.3  0 0 0 -1.1 0.62" />
      </filter>
      <filter id="fibers">
        <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="4" seed="9" />
        <feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.42  0 0 0 0 0.33  0 0 0 -0.6 0.32" />
      </filter>
      <rect width="100%" height="100%" filter="url(#fibers)" />
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);

type Blob = { x: number; y: number; rx: number; ry: number; color: string; delay: number; seed: number };

const Watercolor: React.FC<{ blobs: Blob[]; progress: (delay: number) => number; breathe: number; edge: string }> = ({
  blobs,
  progress,
  breathe,
  edge,
}) => {
  const { width, height } = useVideoConfig();
  return (
    <svg width={width} height={height} style={{ position: "absolute", mixBlendMode: "multiply" }}>
      {blobs.map((b, i) => {
        const p = progress(b.delay);
        // wet edge: strong displacement while the pigment spreads, settling as it dries
        const disp = interpolate(p, [0, 1], [140, 55]);
        return (
          <filter key={`f${i}`} id={`wc${i}`} filterUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
            <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed={b.seed} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={disp} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="1.2" />
          </filter>
        );
      })}
      <filter id="edge" filterUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
        <feGaussianBlur stdDeviation="3" />
      </filter>
      {blobs.map((b, i) => {
        const p = progress(b.delay);
        const s = p * (1 + 0.035 * breathe);
        return (
          <g key={i} filter={`url(#wc${i})`} opacity={interpolate(p, [0, 0.3, 1], [0, 0.75, 0.62])}>
            <ellipse cx={b.x} cy={b.y} rx={b.rx * s} ry={b.ry * s} fill={b.color} />
            {/* pigment pooling at the edge, typical of watercolor */}
            <ellipse
              cx={b.x}
              cy={b.y}
              rx={b.rx * s}
              ry={b.ry * s}
              fill="none"
              stroke={edge}
              strokeOpacity={0.28 * p}
              strokeWidth={Math.max(2, b.rx * 0.04)}
              filter="url(#edge)"
            />
          </g>
        );
      })}
    </svg>
  );
};

export const MotionDesign: React.FC<MotionPlan> = (plan) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const base = Math.min(width, height);
  const feel = FEEL[plan.feel];
  const bf = plan.beatFrames;
  const { paper, accent, ink } = plan.palette;

  // 1) brush / watercolor reveal lands exactly on the hero downbeat
  const revealStart = Math.max(0, plan.heroFrame - feel.reveal * bf);
  const revealLen = Math.max(1, plan.heroFrame - revealStart);
  const progress = (delay: number) =>
    interpolate(frame, [revealStart + delay * revealLen, plan.heroFrame + delay * bf], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: feel.ease,
    });

  const cx = width / 2;
  const cy = height / 2;
  // blobs framed around the title (balanced ring), deterministic jitter
  const angles = [200, 335, 25, 150, 265];
  const blobs: Blob[] = angles.map((deg, i) => ({
    x: cx + Math.cos((deg * Math.PI) / 180) * width * (0.3 + random(`x${i}`) * 0.06),
    y: cy + Math.sin((deg * Math.PI) / 180) * height * (0.3 + random(`y${i}`) * 0.06),
    rx: base * (0.16 + random(`r${i}`) * 0.1),
    ry: base * (0.13 + random(`q${i}`) * 0.08),
    color: i % 3 === 2 ? ink : accent,
    delay: i * 0.12,
    seed: 11 + i * 7,
  }));

  // brush swipe: a dry-brush stroke crossing the frame, finishing on the hero beat
  const swipe = progress(0);
  const swipeY = cy + base * 0.02;
  const swipeLen = width * 0.8;

  // 2) accents: every beat after the hero, downbeats stronger
  const accents = plan.beats.filter((b) => b.frame >= plan.heroFrame);
  const beatHit = pulse(frame, accents, Math.round(bf * 0.9));
  const downHit = pulse(frame, accents, Math.round(bf * 1.2), true);

  // 3) scale-up on the next strong beat
  const scaleUp = beatProgress(frame, plan.scaleFrame, feel.scale, bf, feel.pop);
  const titleScale = 1 + 0.14 * scaleUp + 0.025 * beatHit;

  const letters = Array.from(plan.title);
  const letterStagger = Math.min(0.08, 0.6 / Math.max(1, letters.length)); // in beats
  const subtitleIn = beatProgress(frame, plan.scaleFrame + bf, 1, bf, feel.ease);

  const fontSize = Math.min(base * 0.16, (width * 0.82) / Math.max(4, letters.length * 0.62));
  const beatIdx = accents.filter((b) => b.frame <= frame).length;

  return (
    <AbsoluteFill>
      <Paper color={paper} />
      <Watercolor blobs={blobs} progress={progress} breathe={downHit} edge={ink} />
      <svg width={width} height={height} style={{ position: "absolute", mixBlendMode: "multiply" }}>
        <filter id="drybrush" filterUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
          {/* bristle streaks along the stroke + ragged edges */}
          <feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="3" seed="5" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={base * 0.05} xChannelSelector="R" yChannelSelector="G" result="d" />
          <feTurbulence type="fractalNoise" baseFrequency="0.002 0.25" numOctaves="2" seed="8" result="streaks" />
          <feColorMatrix in="streaks" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.7" result="mask" />
          <feComposite in="d" in2="mask" operator="in" />
        </filter>
        <path
          d={`M ${cx - swipeLen / 2} ${swipeY} C ${cx - swipeLen / 6} ${swipeY - base * 0.05}, ${cx + swipeLen / 6} ${swipeY + base * 0.05}, ${cx + swipeLen / 2} ${swipeY - base * 0.01}`}
          stroke={accent}
          strokeWidth={base * 0.16}
          strokeLinecap="round"
          fill="none"
          filter="url(#drybrush)"
          opacity={0.9}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - swipe}
        />
      </svg>

      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontFamily: serif,
            fontWeight: 700,
            fontSize,
            color: ink,
            letterSpacing: "-0.02em",
            lineHeight: 1,
            scale: titleScale,
          }}
        >
          {letters.map((ch, i) => {
            const p = beatProgress(frame, plan.heroFrame + i * letterStagger * bf, feel.letter, bf, feel.ease);
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  whiteSpace: "pre",
                  opacity: p,
                  translate: `0px ${(1 - p) * fontSize * 0.35}px`,
                  // ends perfectly crisp: blur reaches exactly 0 when the letter lands
                  filter: p < 1 ? `blur(${(1 - p) * fontSize * 0.08}px)` : "none",
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>
        {plan.subtitle ? (
          <div
            style={{
              marginTop: fontSize * 0.45,
              fontFamily: sans,
              fontWeight: 500,
              fontSize: fontSize * 0.2,
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              color: ink,
              opacity: subtitleIn,
              translate: `0px ${(1 - subtitleIn) * fontSize * 0.15}px`,
            }}
          >
            {plan.subtitle}
          </div>
        ) : null}
        {/* small accents on the beats in between */}
        <div style={{ display: "flex", gap: fontSize * 0.14, marginTop: fontSize * 0.35 }}>
          {[0, 1, 2, 3].map((i) => {
            const active = frame >= plan.heroFrame && (beatIdx - 1) % 4 === i;
            return (
              <div
                key={i}
                style={{
                  width: fontSize * 0.09,
                  height: fontSize * 0.09,
                  borderRadius: "50%",
                  backgroundColor: i === 0 ? accent : ink,
                  opacity: frame >= plan.heroFrame ? 0.35 + (active ? 0.65 * beatHit : 0) : 0,
                  scale: 1 + (active ? 0.8 * beatHit : 0),
                }}
              />
            );
          })}
        </div>
      </AbsoluteFill>
      {plan.audio.src ? (
        <Audio src={resolve(plan.audio.src)} trimBefore={Math.round(plan.audio.startSec * fps)} />
      ) : null}
    </AbsoluteFill>
  );
};
