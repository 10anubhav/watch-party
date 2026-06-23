import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { socket } from "../lib/socket.js";
import VideoTile from "./VideoTile.jsx";
import Chat from "./Chat.jsx";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
    // Add a TURN server here for production reliability.
  ],
};

const MEDIA_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48000 },
};

const DISPLAY_MEDIA_OPTIONS = {
  video: { frameRate: 30 },
  audio: {
    ...MEDIA_AUDIO_CONSTRAINTS,
    suppressLocalAudioPlayback: false,
  },
};

const preferHighQualityAudio = (sdp) => {
  if (!sdp) return sdp;

  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, payload, params) => {
    const rtpmap = new RegExp(`a=rtpmap:${payload} opus/48000`, "i");
    if (!rtpmap.test(sdp)) return line;

    const values = new Map(
      params
        .split(";")
        .map((param) => param.trim())
        .filter(Boolean)
        .map((param) => {
          const [key, ...rest] = param.split("=");
          return [key, rest.join("=") || "1"];
        }),
    );

    values.set("stereo", "1");
    values.set("sprop-stereo", "1");
    values.set("maxaveragebitrate", "510000");
    values.set("useinbandfec", "1");
    values.set("usedtx", "0");

    return `a=fmtp:${payload} ${Array.from(values, ([key, value]) => `${key}=${value}`).join(";")}`;
  });
};

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const username = sessionStorage.getItem("username") || "Guest";

  const [localStream, setLocalStream] = useState(null);
  const [peers, setPeers] = useState({}); // socketId -> { pc, stream, username }
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  const peersRef = useRef({}); // mirror of peers state for sync access
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const cameraTrackRef = useRef(null); // remember original camera track during screen share
  const micTrackRef = useRef(null);
  const audioContextRef = useRef(null);
  const silentAudioContextRef = useRef(null);

  // ---- Helpers --------------------------------------------------------
  const upsertPeer = (id, data) => {
    peersRef.current[id] = { ...peersRef.current[id], ...data };
    setPeers({ ...peersRef.current });
  };
  const removePeer = (id) => {
    const p = peersRef.current[id];
    if (p?.pc) p.pc.close();
    delete peersRef.current[id];
    setPeers({ ...peersRef.current });
  };

  const createSilentAudioTrack = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;

    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();

    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    silentAudioContextRef.current = ctx;
    const [track] = destination.stream.getAudioTracks();
    track.enabled = false;
    return track;
  };

  const ensureAudioTrack = (stream) => {
    const existingTrack = stream.getAudioTracks()[0];
    if (existingTrack) return existingTrack;

    const silentTrack = createSilentAudioTrack();
    if (silentTrack) stream.addTrack(silentTrack);
    return silentTrack;
  };

  const getInitialLocalStream = async () => {
    const tracks = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: MEDIA_AUDIO_CONSTRAINTS,
      });
      stream.getTracks().forEach((track) => tracks.push(track));
    } catch (err) {
      console.warn("Camera/mic together failed; trying separately.", err);

      try {
        const videoOnly = await navigator.mediaDevices.getUserMedia({ video: true });
        videoOnly.getVideoTracks().forEach((track) => tracks.push(track));
      } catch (videoErr) {
        console.warn("Camera access failed.", videoErr);
      }

      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({
          audio: MEDIA_AUDIO_CONSTRAINTS,
        });
        audioOnly.getAudioTracks().forEach((track) => tracks.push(track));
      } catch (audioErr) {
        console.warn("Mic access failed.", audioErr);
      }
    }

    const stream = new MediaStream(tracks);
    ensureAudioTrack(stream);
    return stream;
  };

  const tuneAudioSender = (sender) => {
    if (!sender) return;

    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = 510000;
    sender.setParameters(params).catch((err) => {
      console.warn("Unable to apply high-quality audio sender parameters.", err);
    });
  };

  const createPeerConnection = (remoteId, remoteName) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Push our local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStreamRef.current);
        if (track.kind === "audio") tuneAudioSender(sender);
      });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("ice-candidate", { to: remoteId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      upsertPeer(remoteId, { stream: e.streams[0], username: remoteName });
    };

    pc.onconnectionstatechange = () => {
      if (
        ["failed", "disconnected", "closed"].includes(pc.connectionState)
      ) {
        // keep entry; user-left handler will clean up
      }
    };

    return pc;
  };

  // ---- Setup ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const stream = await getInitialLocalStream();
      if (cancelled) return;
      localStreamRef.current = stream;
      cameraTrackRef.current = stream.getVideoTracks()[0] || null;
      micTrackRef.current = stream.getAudioTracks()[0] || null;
      setCamOn(!!cameraTrackRef.current);
      setMicOn(!!micTrackRef.current && micTrackRef.current.enabled);
      setLocalStream(stream);

      socket.connect();
      socket.emit("join-room", { roomId, username });

      // 1. Existing users list -> we (newcomer) create offers to each
      socket.on("all-users", (users) => {
        users.forEach(({ socketId, username: uname }) => {
          const pc = createPeerConnection(socketId, uname);
          upsertPeer(socketId, { pc, username: uname });
          pc.createOffer()
            .then((offer) =>
              pc.setLocalDescription({
                type: offer.type,
                sdp: preferHighQualityAudio(offer.sdp),
              }),
            )
            .then(() => {
              socket.emit("sending-signal", {
                userToSignal: socketId,
                signal: pc.localDescription,
              });
            });
        });
      });

      // 2. Existing user receives newcomer's offer
      socket.on("user-joined", async ({ signal, callerId, username: uname }) => {
        const pc = createPeerConnection(callerId, uname);
        upsertPeer(callerId, { pc, username: uname });
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({
          type: answer.type,
          sdp: preferHighQualityAudio(answer.sdp),
        });
        socket.emit("returning-signal", {
          callerId,
          signal: pc.localDescription,
        });
      });

      // 3. Newcomer receives the answer
      socket.on("receiving-returned-signal", async ({ signal, id }) => {
        const pc = peersRef.current[id]?.pc;
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal));
      });

      // ICE
      socket.on("ice-candidate", async ({ from, candidate }) => {
        const pc = peersRef.current[from]?.pc;
        if (pc && candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.warn("addIceCandidate failed", e);
          }
        }
      });

      socket.on("user-left", ({ socketId }) => removePeer(socketId));
    };

    init();

    return () => {
      cancelled = true;
      socket.off("all-users");
      socket.off("user-joined");
      socket.off("receiving-returned-signal");
      socket.off("ice-candidate");
      socket.off("user-left");
      Object.values(peersRef.current).forEach((p) => p.pc && p.pc.close());
      peersRef.current = {};
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close();
      silentAudioContextRef.current?.close();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // ---- Controls -------------------------------------------------------
  const toggleCam = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  };

  const toggleMic = () => {
    const track = micTrackRef.current;
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  };

  const replaceVideoTrackOnAllPeers = (newTrack) => {
    Object.values(peersRef.current).forEach(({ pc }) => {
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) sender.replaceTrack(newTrack);
    });
  };
  const replaceAudioTrackOnAllPeers = (newTrack) => {
    if (!newTrack) return;
    Object.values(peersRef.current).forEach(({ pc }) => {
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
      if (sender) {
        sender.replaceTrack(newTrack).then(() => tuneAudioSender(sender));
      } else {
        tuneAudioSender(
          pc.addTrack(newTrack, localStreamRef.current || new MediaStream([newTrack])),
        );
      }
    });
  };

  const startScreenShare = async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
      screenStreamRef.current = screen;
      const screenVideoTrack = screen.getVideoTracks()[0];
      const screenAudioTrack = screen.getAudioTracks()[0]; // undefined if nothing was shared

      if (screenAudioTrack?.applyConstraints) {
        try {
          await screenAudioTrack.applyConstraints(MEDIA_AUDIO_CONSTRAINTS);
        } catch (err) {
          console.warn("Unable to apply full-quality screen audio constraints.", err);
        }
      }

      cameraTrackRef.current = localStreamRef.current?.getVideoTracks()[0] || null;
      micTrackRef.current = localStreamRef.current?.getAudioTracks()[0] || null;

      replaceVideoTrackOnAllPeers(screenVideoTrack);

      let outgoingAudioTrack = micTrackRef.current;

      if (screenAudioTrack) {
        // Mix your mic + the shared tab/system audio into one track,
        // so your friend hears the movie AND you talking, on the same
        // audio channel that's already connected (no renegotiation needed).
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const ctx = new AudioContext();
          await ctx.resume();
          const destination = ctx.createMediaStreamDestination();

          if (micTrackRef.current && micTrackRef.current.readyState !== "ended") {
            ctx.createMediaStreamSource(new MediaStream([micTrackRef.current])).connect(destination);
          }
          ctx.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(destination);

          audioContextRef.current = ctx;
          outgoingAudioTrack = destination.stream.getAudioTracks()[0];
        } else {
          outgoingAudioTrack = screenAudioTrack;
        }
        outgoingAudioTrack.enabled = true;
      } else {
        console.warn(
          "No audio was captured from the share — your friend will only hear your mic, not the movie. " +
          "Pick 'Chrome Tab' in the share dialog and check 'Share tab audio'."
        );
      }

      replaceAudioTrackOnAllPeers(outgoingAudioTrack);

      const newLocal = new MediaStream([screenVideoTrack, outgoingAudioTrack].filter(Boolean));
      localStreamRef.current = newLocal;
      setLocalStream(newLocal);
      setSharing(true);

      screenVideoTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.warn("Screen share cancelled", err);
    }
  };

  const stopScreenShare = async () => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    let camTrack = cameraTrackRef.current;
    if (!camTrack || camTrack.readyState === "ended") {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
        camTrack = fresh.getVideoTracks()[0];
      } catch {
        camTrack = null;
      }
    }
    if (camTrack) replaceVideoTrackOnAllPeers(camTrack);

    let micTrack = micTrackRef.current;
    if (!micTrack || micTrack.readyState === "ended") {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ audio: true });
        micTrack = fresh.getAudioTracks()[0];
        micTrackRef.current = micTrack;
      } catch {
        micTrack = createSilentAudioTrack();
        micTrackRef.current = micTrack;
      }
    }
    if (micTrack) micTrack.enabled = micOn;
    if (micTrack) replaceAudioTrackOnAllPeers(micTrack);

    const newLocal = new MediaStream([camTrack, micTrack].filter(Boolean));
    localStreamRef.current = newLocal;
    setLocalStream(newLocal);
    setSharing(false);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const leave = () => navigate("/");

  // ---- Render ---------------------------------------------------------
  return (
    <div className="min-h-full flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-950">
        <div>
          <div className="font-semibold">🎬 Watch Party</div>
          <div className="text-xs text-neutral-400">Room {roomId}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={copyLink}
            className="px-3 py-1.5 text-sm rounded-lg bg-neutral-800 hover:bg-neutral-700"
          >
            {copied ? "Copied!" : "Copy invite link"}
          </button>
          <button
            onClick={leave}
            className="px-3 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-500"
          >
            Leave
          </button>
        </div>
      </header>

      {/* Main */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-4">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {localStream && (
              <VideoTile
                stream={localStream}
                username={username}
                muted
                isLocal
              />
            )}
            {Object.entries(peers).map(([id, p]) =>
              p.stream ? (
                <VideoTile
                  key={id}
                  stream={p.stream}
                  username={p.username || "Guest"}
                />
              ) : null,
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={toggleCam}
              className={`px-4 py-2 rounded-lg ${camOn ? "bg-neutral-800 hover:bg-neutral-700" : "bg-red-600 hover:bg-red-500"}`}
            >
              {camOn ? "Cam on" : "Cam off"}
            </button>
            <button
              onClick={toggleMic}
              className={`px-4 py-2 rounded-lg ${micOn ? "bg-neutral-800 hover:bg-neutral-700" : "bg-red-600 hover:bg-red-500"}`}
            >
              {micOn ? "Mic on" : "Mic off"}
            </button>
            <button
              onClick={sharing ? stopScreenShare : startScreenShare}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500"
            >
              {sharing ? "Stop sharing" : "Share screen / movie"}
            </button>
          </div>
        </div>

        <div className="h-[70vh] lg:h-auto">
          <Chat roomId={roomId} />
        </div>
      </div>
    </div>
  );
}
