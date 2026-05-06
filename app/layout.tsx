import type { Metadata } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";
import { ChatBubbleGate } from "@/components/chat/ChatBubbleGate";
import { BottomNav } from "@/components/layout/BottomNav";
import { Fab } from "@/components/layout/Fab";
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
      <body className="min-h-[100dvh] bg-bg pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+var(--nav-h))]">
        <TopNav />
        <main>{children}</main>
        <BottomNav />
        <Fab />
        <ChatBubbleGate />
      </body>
    </html>
  );
}
