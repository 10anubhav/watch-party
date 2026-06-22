import { useEffect, useRef } from "react";

export default function VideoTile({ stream, username, muted = false, isLocal }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative bg-neutral-800 rounded-xl overflow-hidden aspect-video border border-neutral-700">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className="w-full h-full object-cover"
      />
      <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/60 text-xs">
        {username} {isLocal && "(you)"}
      </div>
    </div>
  );
}
