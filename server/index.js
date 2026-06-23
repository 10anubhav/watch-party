require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const roomsRouter = require("./routes/rooms");

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/watchparty";

const app = express();
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use("/", roomsRouter);
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ["GET", "POST"] },
});

// roomId -> Map(socketId -> username)
const roomUsers = new Map();

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("join-room", ({ roomId, username }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username || "Guest";

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Map());
    const users = roomUsers.get(roomId);

    // Send list of *existing* users to the newcomer (so they can build offers)
    const existing = Array.from(users.entries()).map(([id, name]) => ({
      socketId: id,
      username: name,
    }));
    socket.emit("all-users", existing);

    users.set(socket.id, socket.data.username);

    // Notify everyone of presence (for the user list)
    io.to(roomId).emit(
      "room-users",
      Array.from(users.entries()).map(([id, name]) => ({
        socketId: id,
        username: name,
      })),
    );
  });

  // WebRTC signaling --------------------------------------------------
  // Newcomer -> existing user: offer
  socket.on("sending-signal", ({ userToSignal, signal }) => {
    io.to(userToSignal).emit("user-joined", {
      signal,
      callerId: socket.id,
      username: socket.data.username,
    });
  });

  // Existing user -> newcomer: answer
  socket.on("returning-signal", ({ callerId, signal }) => {
    io.to(callerId).emit("receiving-returned-signal", {
      signal,
      id: socket.id,
    });
  });

  // ICE candidates (both directions)
  socket.on("ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  // Chat -------------------------------------------------------------
  socket.on("chat-message", ({ roomId, text }) => {
    io.to(roomId).emit("chat-message", {
      username: socket.data.username,
      text,
      ts: Date.now(),
    });
  });

  // Disconnect -------------------------------------------------------
  socket.on("disconnect", () => {
    const { roomId } = socket.data || {};
    if (roomId && roomUsers.has(roomId)) {
      const users = roomUsers.get(roomId);
      users.delete(socket.id);
      if (users.size === 0) roomUsers.delete(roomId);
      else {
        io.to(roomId).emit(
          "room-users",
          Array.from(users.entries()).map(([id, name]) => ({
            socketId: id,
            username: name,
          })),
        );
        socket.to(roomId).emit("user-left", { socketId: socket.id });
      }
    }
  });
});

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    server.listen(PORT, () =>
      console.log(`Server listening on http://localhost:${PORT}`),
    );
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
