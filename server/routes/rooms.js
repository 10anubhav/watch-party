const express = require("express");
const { nanoid } = require("nanoid");
const Room = require("../models/Room");

const router = express.Router();

// POST /create-room  -> { roomId, link }
router.post("/create-room", async (req, res) => {
  try {
    const { hostName } = req.body || {};
    const roomId = nanoid(10);
    await Room.create({ roomId, hostName: hostName || "Host" });
    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    res.json({ roomId, link: `${clientUrl}/room/${roomId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create room" });
  }
});

// GET /join-room/:id -> validates room exists
router.get("/join-room/:id", async (req, res) => {
  const room = await Room.findOne({ roomId: req.params.id });
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ roomId: room.roomId, hostName: room.hostName });
});

module.exports = router;
