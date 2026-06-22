# Watch Party (Scener-like)

Private rooms to watch movies together with screen share, webcam tiles, and chat.

## Stack
- **Frontend:** React 18 + Vite + TailwindCSS + socket.io-client + WebRTC
- **Backend:** Node.js + Express + Socket.IO + MongoDB (Mongoose)
- **Realtime:** WebRTC (mesh P2P) for screen/cam, Socket.IO for signaling + chat

## Folder Structure
```
watch-party/
├── server/                 # Node.js backend
│   ├── package.json
│   ├── .env.example
│   ├── index.js            # Express + Socket.IO entry
│   ├── models/Room.js      # MongoDB schema
│   └── routes/rooms.js     # REST endpoints
└── client/                 # React frontend
    ├── package.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── index.css
        ├── lib/socket.js
        └── components/
            ├── Home.jsx
            ├── Room.jsx
            ├── VideoTile.jsx
            └── Chat.jsx
```

## Run locally

### 1. Backend
```bash
cd server
cp .env.example .env        # edit MONGO_URI if needed
npm install
npm run dev                 # http://localhost:5000
```
You need MongoDB running locally (`mongodb://localhost:27017/watchparty`) or set `MONGO_URI` to a MongoDB Atlas connection string.

### 2. Frontend
```bash
cd client
npm install
npm run dev                 # http://localhost:5173
```

Open `http://localhost:5173`, enter a username, click **Create Room**, copy the link from the URL bar and share with friends.

## How it works

### WebRTC signaling with Socket.IO
1. Client joins room → server emits `all-users` (list of existing socket IDs) to the newcomer.
2. Newcomer creates an `RTCPeerConnection` per existing user, generates an SDP **offer**, sends it via `sending-signal`.
3. Server relays as `user-joined` to the target user. Target creates a peer, accepts the offer, returns an SDP **answer** via `returning-signal`.
4. Server relays as `receiving-returned-signal`. ICE candidates flow over the same channel via `ice-candidate`.
5. Once ICE completes, the `ontrack` event fires and each side renders the remote `MediaStream`.

This is a **mesh topology** — every peer connects to every other peer. Great for ≤ 6 users; beyond that, use an SFU (mediasoup / LiveKit).

### Screen sharing
The host calls `navigator.mediaDevices.getDisplayMedia()`. We `replaceTrack` on every existing `RTCPeerConnection`'s video sender so all peers instantly see the screen instead of the webcam.

### Webcam tiles
Each peer's `MediaStream` is rendered in a `<video>` element inside a grid. Local stream is muted to prevent echo.

### Chat
Plain Socket.IO `chat-message` events broadcast to the room.

## Deployment
- **Frontend → Vercel:** `cd client && vercel`. Set `VITE_SERVER_URL` to your backend URL.
- **Backend → Render / Railway / Heroku:** point to `server/`, set env vars `MONGO_URI`, `CLIENT_URL`, `PORT`. WebSockets must be enabled (Render/Railway support them by default).
- For production HTTPS is required for `getUserMedia` / `getDisplayMedia`.
- Add a TURN server (e.g. Twilio Network Traversal, coturn) for users behind strict NATs — STUN alone is insufficient on many corporate networks.
