import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AudioPlayerProvider } from "@/lib/audio-player-context";
import { GlobalMiniPlayer } from "@/app/components/GlobalMiniPlayer";

export const metadata: Metadata = {
  title: "Nexus Director — Autonomous Software Factory",
  description: "Turn raw media archives into fully deployed, iPad-optimized digital products. One command. Five AI agents. Complete business infrastructure."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  userScalable: false
};

type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-[#02040d] text-slate-100 antialiased">
        <AudioPlayerProvider>
          {children}
          <GlobalMiniPlayer />
        </AudioPlayerProvider>
      </body>
    </html>
  );
}
