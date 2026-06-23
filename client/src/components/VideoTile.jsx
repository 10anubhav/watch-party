import { useEffect, useRef, useState } from "react";

export default function VideoTile({ stream, username, muted = false, isLocal }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    video.muted = muted;

    const playPromise = video.play();
    if (playPromise?.catch) {
      playPromise
        .then(() => setNeedsAudioUnlock(false))
        .catch(() => setNeedsAudioUnlock(!muted));
    }
  }, [stream, muted]);

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);

    const video = videoRef.current;
    const onIOSBegin = () => setIsFullscreen(true);
    const onIOSEnd = () => setIsFullscreen(false);
    video?.addEventListener("webkitbeginfullscreen", onIOSBegin);
    video?.addEventListener("webkitendfullscreen", onIOSEnd);

    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      video?.removeEventListener("webkitbeginfullscreen", onIOSBegin);
      video?.removeEventListener("webkitendfullscreen", onIOSEnd);
    };
  }, []);

  const toggleFullscreen = () => {
    const container = containerRef.current;
    const video = videoRef.current;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

    if (!fsEl) {
      if (container.requestFullscreen) container.requestFullscreen();
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS Safari fallback
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  };

  const enableAudio = async () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = false;
    try {
      await video.play();
      setNeedsAudioUnlock(false);
    } catch (err) {
      console.warn("Unable to start remote audio playback.", err);
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative bg-neutral-800 rounded-xl overflow-hidden aspect-video border border-neutral-700"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`w-full h-full ${isFullscreen ? "object-contain bg-black" : "object-cover"}`}
      />

      {needsAudioUnlock && !isLocal && (
        <button
          onClick={enableAudio}
          className="absolute inset-x-3 bottom-10 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo
-500"
        >
          Enable audio
        </button>
      )}

      <button
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors"
      >
        {isFullscreen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="roun
d" strokeLinejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
            <path d="M3 16h3a2 2 0 0 1 2 2v3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="roun
d" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
            <path d="M3 16v3a2 2 0 0 0 2 2h3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        )}
      </button>

      <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/60 text-xs">
        {username} {isLocal && "(you)"}
      </div>
    </div>
  );
}