import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { SERVER_URL } from "../lib/socket.js";

export default function Home() {
  const [username, setUsername] = useState("");
  const [joinId, setJoinId] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const saveName = () => {
    if (!username.trim()) return false;
    sessionStorage.setItem("username", username.trim());
    return true;
  };

  const createRoom = async () => {
    if (!saveName()) return alert("Enter a username");
    setLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/create-room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostName: username }),
      });
      const data = await res.json();
      navigate(`/room/${data.roomId}`);
    } catch (e) {
      alert("Could not create room. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  const joinRoom = () => {
    if (!saveName()) return alert("Enter a username");
    if (!joinId.trim()) return alert("Enter a room ID or paste a link");
    const id = joinId.includes("/room/")
      ? joinId.split("/room/")[1].split(/[/?#]/)[0]
      : joinId.trim();
    navigate(`/room/${id}`);
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-neutral-900 rounded-2xl p-8 shadow-xl border border-neutral-800">
        <h1 className="text-3xl font-bold mb-1">🎬 Watch Party</h1>
        <p className="text-neutral-400 mb-6">
          Host private rooms and watch together.
        </p>

        <label className="block text-sm mb-1 text-neutral-300">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Your name"
          className="w-full mb-4 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 focus:outline-none focus:border-indigo-500"
        />

        <button
          onClick={createRoom}
          disabled={loading}
          className="w-full mb-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 font-medium disabled:opacity-50"
        >
          {loading ? "Creating…" : "Create Room"}
        </button>

        <div className="border-t border-neutral-800 pt-5">
          <label className="block text-sm mb-1 text-neutral-300">
            Join with link or ID
          </label>
          <div className="flex gap-2">
            <input
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              placeholder="paste link or ID"
              className="flex-1 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={joinRoom}
              className="px-4 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600"
            >
              Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
