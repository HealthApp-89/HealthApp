import { ImageResponse } from "next/og";

// Apple touch icon — iOS ignores SVG for this slot, so we render PNG via
// next/og at request time. 180x180 is the canonical iOS home-screen size.
// Lives next to app/icon.svg, served at /apple-icon.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(circle at 50% 38%, #15233f 0%, #080e1a 100%)",
          borderRadius: 40,
          position: "relative",
        }}
      >
        {/* Three-quarter cyan ring */}
        <div
          style={{
            position: "absolute",
            width: 110,
            height: 110,
            borderRadius: "50%",
            border: "10px solid transparent",
            borderTopColor: "#00f5c4",
            borderRightColor: "#00f5c4",
            borderBottomColor: "#4fc3f7",
            transform: "rotate(135deg)",
            boxShadow: "0 0 22px #00f5c466",
          }}
        />
        {/* Pulse line */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            fontSize: 30,
            fontWeight: 700,
            fontFamily: "system-ui, sans-serif",
            letterSpacing: -1,
          }}
        >
          ♥
        </div>
      </div>
    ),
    { ...size },
  );
}
