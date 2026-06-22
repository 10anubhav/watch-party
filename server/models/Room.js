const mongoose = require("mongoose");

const RoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, index: true },
  hostName: { type: String, default: "Host" },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }, // auto-delete after 24h
});

module.exports = mongoose.model("Room", RoomSchema);
