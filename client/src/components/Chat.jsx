import { useEffect, useRef, useState } from "react";
import { socket } from "../lib/socket.js";

export default function Chat({ roomId }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    const onMsg = (m) => setMessages((prev) => [...prev, m]);
    socket.on("chat-message", onMsg);
    return () => socket.off("chat-message", onMsg);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    socket.emit("chat-message", { roomId, text: text.trim() });
    setText("");
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border border-neutral-800 rounded-xl">
      <div className="px-4 py-3 border-b border-neutral-800 font-semibold">
        Chat
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
        {messages.map((m, i) => (
          <div key={i}>
            <span className="text-indigo-400 font-medium">{m.username}: </span>
            <span className="text-neutral-200">{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={send} className="p-3 border-t border-neutral-800 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 focus:outline-none focus:border-indigo-500 text-sm"
        />
        <button className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm">
          Send
        </button>
      </form>
    </div>
  );
}
