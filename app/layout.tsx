import type { Metadata } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";
import { BottomNav } from "@/components/layout/BottomNav";
import { FabGate } from "@/components/layout/FabGate";
import { TopNav } from "@/components/layout/TopNav";

// Self-hosted via next/font — removes the render-blocking Google CSS
// round-trip (~200ms cold on LTE) and ships zero layout shift.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
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
  themeColor: "#f1f2f6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <head>
        {/*
          The Next.js Viewport export does not currently support the
          `interactive-widget` field, which iOS PWA standalone mode requires
          to fire visualViewport.resize reliably. The chat panel's keyboard
          handler depends on that event. We use a manual <meta> tag to include
          interactive-widget=resizes-content alongside the standard fields.
        */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
      </head>
      {/* Padding-top/bottom for safe-area + bottom-nav are set in globals.css.
          They were inline as `pb-[calc(env(...)+var(--nav-h))]`, but Tailwind
          arbitrary values strip the spaces around `+` and WebKit/Blink reject
          calc() without those spaces, so the rule was being silently dropped. */}
      <body className="min-h-[100dvh] bg-bg">
        <TopNav />
        <main>{children}</main>
        <BottomNav />
        <FabGate />
      </body>
    </html>
  );
}
