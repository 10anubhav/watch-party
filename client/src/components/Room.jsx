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
  const [micOn, setMicOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [screenAudioStatus, setScreenAudioStatus] = useState("idle");
  const [copied, setCopied] = useState(false);

  const peersRef = useRef({}); // mirror of peers state for sync access
  const peerStreamsRef = useRef({});
  const pendingIceRef = useRef({}); // socketId -> RTCIceCandidateInit[]
  const pendingNegotiationRef = useRef(new Set());
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const screenAudioTrackRef = useRef(null);
  const cameraTrackRef = useRef(null); // remember original camera track during screen share
  const micTrackRef = useRef(null);
  const placeholderAudioTrackRef = useRef(null);
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
    const existingStream = peerStreamsRef.current[id];
    existingStream?.getTracks().forEach((track) => track.stop());
    delete pendingIceRef.current[id];
    delete peerStreamsRef.current[id];
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
    placeholderAudioTrackRef.current = track;
    return track;
  };

  const getPlaceholderAudioTrack = () => {
    if (
      placeholderAudioTrackRef.current &&
      placeholderAudioTrackRef.current.readyState !== "ended"
    ) {
      return placeholderAudioTrackRef.current;
    }

    return createSilentAudioTrack();
  };

  const ensureAudioTrack = (stream) => {
    const existingTrack = stream.getAudioTracks()[0];
    if (existingTrack) return existingTrack;

    const silentTrack = getPlaceholderAudioTrack();
    if (silentTrack) stream.addTrack(silentTrack);
    return silentTrack;
  };

  const getInitialLocalStream = async () => {
    const tracks = [];

    try {
      const videoOnly = await navigator.mediaDevices.getUserMedia({ video: true });
      videoOnly.getVideoTracks().forEach((track) => tracks.push(track));
    } catch (err) {
      console.warn("Camera access failed.", err);
    }

    const stream = new MediaStream(tracks);
    ensureAudioTrack(stream);
    return stream;
  };

  const requestMicTrack = async () => {
    if (micTrackRef.current && micTrackRef.current.readyState !== "ended") {
      micTrackRef.current.enabled = true;
      return micTrackRef.current;
    }

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: MEDIA_AUDIO_CONSTRAINTS,
    });
    const [micTrack] = micStream.getAudioTracks();
    micTrackRef.current = micTrack;
    return micTrack;
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

  const addOrQueueIceCandidate = async (from, candidate) => {
    const pc = peersRef.current[from]?.pc;
    if (!pc || !candidate) return;

    if (!pc.remoteDescription) {
      pendingIceRef.current[from] = pendingIceRef.current[from] || [];
      pendingIceRef.current[from].push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn("addIceCandidate failed", err);
    }
  };

  const flushQueuedIceCandidates = async (id) => {
    const pc = peersRef.current[id]?.pc;
    const queued = pendingIceRef.current[id] || [];
    if (!pc || !pc.remoteDescription || queued.length === 0) return;

    delete pendingIceRef.current[id];
    for (const candidate of queued) {
      await addOrQueueIceCandidate(id, candidate);
    }
  };

  const closeMixedAudio = () => {
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const createSharedAudioTrack = async (includeMic = micOn) => {
    closeMixedAudio();

    const screenAudioTrack = screenAudioTrackRef.current;
    const hasScreenAudio =
      screenAudioTrack && screenAudioTrack.readyState !== "ended";

    const micTrack = includeMic ? micTrackRef.current : null;
    const hasMicAudio = micTrack && micTrack.readyState !== "ended";

    if (hasScreenAudio && hasMicAudio) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return screenAudioTrack;

      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const destination = ctx.createMediaStreamDestination();

      ctx.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(destination);
      ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(destination);

      audioContextRef.current = ctx;
      const [mixedTrack] = destination.stream.getAudioTracks();
      mixedTrack.enabled = true;
      return mixedTrack;
    }

    if (hasScreenAudio) return screenAudioTrack;
    if (hasMicAudio && !screenStreamRef.current) return micTrack;

    return getPlaceholderAudioTrack();
  };

  const setLocalTracks = (videoTrack, audioTrack) => {
    const nextStream = new MediaStream([videoTrack, audioTrack].filter(Boolean));
    ensureAudioTrack(nextStream);
    localStreamRef.current = nextStream;
    setLocalStream(nextStream);
  };

  const refreshSharedAudio = async (includeMic = micOn) => {
    const outgoingAudioTrack = await createSharedAudioTrack(includeMic);
    await replaceAudioTrackOnAllPeers(outgoingAudioTrack);
    setLocalTracks(screenStreamRef.current?.getVideoTracks()[0], outgoingAudioTrack);
  };

  const negotiatePeer = async (remoteId) => {
    const peer = peersRef.current[remoteId];
    const pc = peer?.pc;
    if (!pc || pendingNegotiationRef.current.has(remoteId)) {
      console.log(`[${remoteId}] Skipping negotiation: pc=${!!pc}, pending=${pendingNegotiationRef.current.has(remoteId)}`);
      return;
    }

    if (!pc.localDescription && !pc.remoteDescription) {
      console.log(`[${remoteId}] Skipping negotiation: no local or remote description yet`);
      return;
    }

    if (pc.signalingState === "closed") {
      console.log(`[${remoteId}] Skipping negotiation: connection closed`);
      return;
    }

    pendingNegotiationRef.current.add(remoteId);
    try {
      const mySocketId = socket.id || "";
      const shouldCreateOffer = mySocketId < remoteId;
      console.log(`[${remoteId}] Renegotiating. signalingState=${pc.signalingState}, shouldCreateOffer=${shouldCreateOffer}`);

      if (shouldCreateOffer) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          console.log(`[${remoteId}] Sent offer`);
          socket.emit("sending-signal", {
            userToSignal: remoteId,
            signal: pc.localDescription,
          });
        } catch (err) {
          console.warn(`[${remoteId}] Offer failed, fallback to answer`, err.message);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("returning-signal", {
            callerId: remoteId,
            signal: pc.localDescription,
          });
        }
      } else {
        try {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          console.log(`[${remoteId}] Sent answer`);
          socket.emit("returning-signal", {
            callerId: remoteId,
            signal: pc.localDescription,
          });
        } catch (err) {
          console.warn(`[${remoteId}] Answer failed, fallback to offer`, err.message);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("sending-signal", {
            userToSignal: remoteId,
            signal: pc.localDescription,
          });
        }
      }
    } catch (err) {
      console.warn(`[${remoteId}] Renegotiation completely failed:`, err.message);
    } finally {
      pendingNegotiationRef.current.delete(remoteId);
    }
  };

  const createPeerConnection = (remoteId, remoteName) => {
    const existingPc = peersRef.current[remoteId]?.pc;
    if (existingPc && existingPc.connectionState !== "closed") {
      upsertPeer(remoteId, { username: remoteName });
      return existingPc;
    }

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
      console.log(`[${remoteId}] ontrack fired. Tracks in stream:`, e.streams[0]?.getTracks().map(t => `${t.kind}(${t.id})`));
      const incomingStream = e.streams[0] || new MediaStream();
      const existingStream = peerStreamsRef.current[remoteId] || incomingStream;

      if (!peerStreamsRef.current[remoteId]) {
        console.log(`[${remoteId}] Created new peer stream`);
        peerStreamsRef.current[remoteId] = existingStream;
      }

      incomingStream.getTracks().forEach((track) => {
        if (!existingStream.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
          console.log(`[${remoteId}] Adding track to stream:`, track.kind, track.id);
          existingStream.addTrack(track);
        }
      });

      if (e.track && !existingStream.getTracks().some((track) => track.id === e.track.id)) {
        console.log(`[${remoteId}] Adding single track:`, e.track.kind, e.track.id);
        existingStream.addTrack(e.track);
      }

      console.log(`[${remoteId}] Final stream tracks:`, existingStream.getTracks().map(t => `${t.kind}(${t.id})`));
      upsertPeer(remoteId, { stream: existingStream, username: remoteName });
    };

    pc.onnegotiationneeded = () => {
      void negotiatePeer(remoteId);
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
      setCamOn(!!cameraTrackRef.current);
      setMicOn(false);
      setLocalStream(stream);

      // 1. Existing users list -> we (newcomer) create offers to each
      socket.on("all-users", async (users) => {
        for (const { socketId, username: uname } of users) {
          const pc = createPeerConnection(socketId, uname);
          upsertPeer(socketId, { pc, username: uname, isOfferer: true });
          const offer = await pc.createOffer();
          await pc.setLocalDescription({
            type: offer.type,
            sdp: preferHighQualityAudio(offer.sdp),
          });
          socket.emit("sending-signal", {
            userToSignal: socketId,
            signal: pc.localDescription,
          });
        }
      });

      // 2. Existing user receives newcomer's offer
      socket.on("user-joined", async ({ signal, callerId, username: uname }) => {
        console.log("[SocketIO] Received user-joined from", callerId, uname);
        const pc = createPeerConnection(callerId, uname);
        upsertPeer(callerId, { pc, username: uname, isOfferer: false });
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        await flushQueuedIceCandidates(callerId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({
          type: answer.type,
          sdp: preferHighQualityAudio(answer.sdp),
        });
        console.log("[SocketIO] Sending answer to", callerId);
        socket.emit("returning-signal", {
          callerId,
          signal: pc.localDescription,
        });
      });

      // 3. Newcomer receives the answer
      socket.on("receiving-returned-signal", async ({ signal, id }) => {
        console.log("[SocketIO] Received answer from", id);
        const pc = peersRef.current[id]?.pc;
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await flushQueuedIceCandidates(id);
          console.log("[SocketIO] Answer set for", id);
        }
      });

      // ICE
      socket.on("ice-candidate", async ({ from, candidate }) => {
        await addOrQueueIceCandidate(from, candidate);
      });

      socket.on("user-left", ({ socketId }) => removePeer(socketId));

      if (!socket.connected) socket.connect();
      socket.emit("join-room", { roomId, username });
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
      Object.values(peerStreamsRef.current).forEach((stream) => stream?.getTracks().forEach((t) => t.stop()));
      peerStreamsRef.current = {};
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      micTrackRef.current?.stop();
      placeholderAudioTrackRef.current?.stop();
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

  const toggleMic = async () => {
    if (micOn) {
      if (micTrackRef.current) micTrackRef.current.enabled = false;
      setMicOn(false);

      if (sharing) {
        await refreshSharedAudio(false);
      } else {
        const placeholderTrack = getPlaceholderAudioTrack();
        await replaceAudioTrackOnAllPeers(placeholderTrack);
        setLocalTracks(localStreamRef.current?.getVideoTracks()[0], placeholderTrack);
      }
      return;
    }

    try {
      const micTrack = await requestMicTrack();
      micTrack.enabled = true;
      setMicOn(true);

      if (sharing) {
        await refreshSharedAudio(true);
      } else {
        await replaceAudioTrackOnAllPeers(micTrack);
        setLocalTracks(localStreamRef.current?.getVideoTracks()[0], micTrack);
      }
    } catch (err) {
      console.warn("Mic access failed.", err);
    }
  };

  const replaceVideoTrackOnAllPeers = async (newTrack) => {
    console.log("[ReplaceVideo] Starting replacement with track:", newTrack?.kind, newTrack?.id);
    await Promise.all(
      Object.entries(peersRef.current).map(async ([remoteId, { pc }]) => {
        if (!pc) return;
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) {
          console.log(`[${remoteId}] Replacing video sender:`, sender.track?.id, "→", newTrack?.id);
          await sender.replaceTrack(newTrack);
        } else {
          console.log(`[${remoteId}] No video sender found, adding track:`, newTrack?.id);
          pc.addTrack(newTrack, localStreamRef.current || new MediaStream([newTrack]));
        }
        console.log(`[${remoteId}] Negotiating after video replacement`);
        await negotiatePeer(remoteId);
      }),
    );
  };

  const replaceAudioTrackOnAllPeers = async (newTrack) => {
    if (!newTrack) return;
    await Promise.all(
      Object.entries(peersRef.current).map(async ([remoteId, { pc }]) => {
        if (!pc) return;
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
          tuneAudioSender(sender);
        } else {
          tuneAudioSender(
            pc.addTrack(newTrack, localStreamRef.current || new MediaStream([newTrack])),
          );
        }
        await negotiatePeer(remoteId);
      }),
    );
  };

  const startScreenShare = async () => {
    try {
      console.log("[ScreenShare] Starting screen share");
      const screen = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
      screenStreamRef.current = screen;
      const screenVideoTrack = screen.getVideoTracks()[0];
      const screenAudioTrack = screen.getAudioTracks()[0];
      screenAudioTrackRef.current = screenAudioTrack || null;
      setScreenAudioStatus(screenAudioTrack ? "captured" : "missing");
      console.log("[ScreenShare] Got screen stream:", {
        video: screenVideoTrack?.id,
        audio: screenAudioTrack?.id,
      });

      if (screenAudioTrack?.applyConstraints) {
        try {
          await screenAudioTrack.applyConstraints(MEDIA_AUDIO_CONSTRAINTS);
        } catch (err) {
          console.warn("Unable to apply full-quality screen audio constraints.", err);
        }
      }

      cameraTrackRef.current = localStreamRef.current?.getVideoTracks()[0] || null;

      console.log("[ScreenShare] Replacing video tracks on all peers");
      await replaceVideoTrackOnAllPeers(screenVideoTrack);

      if (!screenAudioTrack) {
        console.warn(
          "No audio was captured from the share - your friend will not hear the movie. " +
          "Pick 'Chrome Tab' in the share dialog and check 'Share tab audio'."
        );
      }

      const outgoingAudioTrack = await createSharedAudioTrack(micOn);
      console.log("[ScreenShare] Replacing audio tracks on all peers");
      await replaceAudioTrackOnAllPeers(outgoingAudioTrack);
      setLocalTracks(screenVideoTrack, outgoingAudioTrack);
      setSharing(true);
      console.log("[ScreenShare] Screen share active");

      screenVideoTrack.onended = () => {
        console.log("[ScreenShare] Video track ended by user");
        stopScreenShare();
      };
      if (screenAudioTrack) {
        screenAudioTrack.onended = () => {
          console.log("[ScreenShare] Audio track ended by user");
          if (!screenStreamRef.current) return;
          screenAudioTrackRef.current = null;
          setScreenAudioStatus("missing");
          refreshSharedAudio(micOn);
        };
      }
    } catch (err) {
      console.warn("Screen share cancelled", err);
    }
  };

  const stopScreenShare = async () => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    screenAudioTrackRef.current = null;
    setScreenAudioStatus("idle");

    closeMixedAudio();

    let camTrack = cameraTrackRef.current;
    if (!camTrack || camTrack.readyState === "ended") {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
        camTrack = fresh.getVideoTracks()[0];
      } catch {
        camTrack = null;
      }
    }
    if (camTrack) await replaceVideoTrackOnAllPeers(camTrack);

    let outgoingAudioTrack = getPlaceholderAudioTrack();
    if (micOn) {
      try {
        outgoingAudioTrack = await requestMicTrack();
      } catch {
        outgoingAudioTrack = getPlaceholderAudioTrack();
        setMicOn(false);
      }
    } else if (micTrackRef.current) {
      micTrackRef.current.enabled = false;
    }

    await replaceAudioTrackOnAllPeers(outgoingAudioTrack);
    setLocalTracks(camTrack, outgoingAudioTrack);
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

          {sharing && screenAudioStatus === "missing" && (
            <div className="rounded-lg border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              Tab audio was not captured. Share a Chrome tab and turn on Share tab audio.
            </div>
          )}

          {sharing && screenAudioStatus === "captured" && (
            <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
              Tab audio captured. Keep the mic off unless you want to talk.
            </div>
          )}
        </div>

        <div className="h-[70vh] lg:h-auto">
          <Chat roomId={roomId} />
        </div>
      </div>
    </div>
  );
}
