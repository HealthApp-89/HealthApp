"use client";

// components/profile/SoundCheckSection.tsx
//
// One-tap verification for the logger's rest-done cue. The cue can only be
// unlocked from a real user gesture (see lib/logger/audio-cue.ts), and it
// fires minutes into a workout — so without this, confirming it works means
// starting a session and waiting out a rest period.
//
// The button runs the EXACT path the logger uses: unlockCue() on the tap,
// then fireCue() as a timer would. If the phone stays silent, the readout
// says which output was attempted and what the browser complained about,
// which is the difference between a diagnosable report and a mystery.

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import {
  unlockCue,
  fireCue,
  cueDiagnostics,
  type CueDiagnostics,
} from "@/lib/logger/audio-cue";

const PATH_LABEL: Record<CueDiagnostics["lastPath"], string> = {
  media: "media element (survives the mute switch)",
  oscillator: "WebAudio fallback (silenced by the mute switch)",
  none: "nothing played",
};

export function SoundCheckSection() {
  const [report, setReport] = useState<CueDiagnostics | null>(null);

  // Both calls must sit in this handler: unlockCue needs the gesture, and
  // firing straight after proves the unlocked objects actually make sound.
  const runCheck = () => {
    unlockCue();
    fireCue();
    // Let the play() promise settle before reading the diagnostics.
    window.setTimeout(() => setReport(cueDiagnostics()), 400);
  };

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: COLOR.textStrong }}>
            Rest timer sound
          </div>
          <div style={{ fontSize: "11px", color: COLOR.textMuted, marginTop: "2px" }}>
            Buzz + beep when a rest period ends. Test it with your ringer switch
            set the way you keep it at the gym.
          </div>
        </div>
        <button
          type="button"
          onClick={runCheck}
          style={{
            flexShrink: 0,
            fontSize: "12px",
            fontWeight: 600,
            padding: "8px 14px",
            borderRadius: "10px",
            border: "none",
            background: COLOR.accentSoft,
            color: COLOR.accentDeep,
          }}
        >
          Test
        </button>
      </div>

      {report && (
        <div
          style={{
            marginTop: "10px",
            paddingTop: "10px",
            borderTop: `1px solid ${COLOR.divider}`,
            fontSize: "11px",
            color: COLOR.textMuted,
            lineHeight: 1.6,
          }}
        >
          <div>Output: {PATH_LABEL[report.lastPath]}</div>
          <div>
            Audio unlocked: {report.unlocked ? "yes" : "no"}
            {report.contextState ? ` · context ${report.contextState}` : ""}
          </div>
          <div>
            Vibration: {report.vibrateSupported ? "supported" : "not supported on this device"}
          </div>
          {report.lastError && (
            <div style={{ color: COLOR.warningDeep, marginTop: "4px" }}>
              Browser said: {report.lastError}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
