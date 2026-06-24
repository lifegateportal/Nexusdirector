import { AudioPlayerProvider } from "@/lib/audio-player-context";
import { GlobalMiniPlayer } from "@/app/components/GlobalMiniPlayer";

type ReadLayoutProps = {
  children: React.ReactNode;
};

export default function ReadLayout({ children }: ReadLayoutProps) {
  return (
    <AudioPlayerProvider>
      {children}
      <GlobalMiniPlayer />
    </AudioPlayerProvider>
  );
}
