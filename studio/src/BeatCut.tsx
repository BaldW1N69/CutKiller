import { Audio, Video } from "@remotion/media";
import React from "react";
import { AbsoluteFill, Easing, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { pulse } from "./beat";
import { SANS as fontFamily } from "./fonts";
import type { CutPlan } from "./types";


const resolve = (src: string) => (/^https?:\/\//.test(src) ? src : staticFile(src));

export const BeatCut: React.FC<CutPlan> = (plan) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const downbeatPunch = pulse(frame, plan.accents, Math.round(fps * 0.3), true);
  const beatPunch = pulse(frame, plan.accents, Math.round(fps * 0.15));
  const flash =
    plan.drop === null
      ? 0
      : interpolate(frame, [plan.drop, plan.drop + Math.round(fps * 0.25)], [0.85, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.quad),
        }) * (frame >= plan.drop ? 1 : 0);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ scale: 1 + 0.07 * downbeatPunch + 0.015 * beatPunch }}>
        {plan.clips.map((c, i) => (
          <Sequence
            key={i}
            name={`${c.kind} ${i}`}
            from={c.from}
            durationInFrames={c.durationInFrames}
            premountFor={fps}
          >
            <Video
              src={resolve(c.src)}
              trimBefore={Math.round(c.trimBeforeSec * fps)}
              muted
              objectFit="cover"
              style={{ width: "100%", height: "100%" }}
            />
          </Sequence>
        ))}
      </AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: "white", opacity: flash }} />
      {plan.title ? (
        <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: width * 0.06 }}>
          <div
            style={{
              fontFamily,
              fontWeight: 800,
              fontSize: width * 0.06,
              color: "white",
              letterSpacing: "-0.02em",
              textShadow: "0 4px 24px rgba(0,0,0,0.5)",
              scale: 1 + 0.06 * downbeatPunch,
              opacity: interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" }),
            }}
          >
            {plan.title}
          </div>
        </AbsoluteFill>
      ) : null}
      {plan.audio.src ? (
        <Audio src={resolve(plan.audio.src)} trimBefore={Math.round(plan.audio.startSec * fps)} />
      ) : null}
    </AbsoluteFill>
  );
};
