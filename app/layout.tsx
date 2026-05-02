import type { Metadata, Viewport } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font — removes the render-blocking Google CSS
// round-trip (~200ms cold on LTE) and ships zero layout shift.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
  variable: "--font-dm-sans",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-dm-mono",
});

export const metadata: Metadata = {
  title: "Apex Health OS",
  description:
    "Personal health and sport performance tracker — WHOOP + Apple Health + strength training.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Apex",
  },
};

// `maximumScale: 1` blocks iOS double-tap zoom on inputs — biggest perceived-
// speed win on phone. `viewportFit: cover` lets the dashboard paint under the
// notch when the PWA launches in standalone mode.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#080e1a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <body className="min-h-[100dvh] pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+48px)]">
        {children}
      </body>
    </html>
  );
}
