import { io } from "socket.io-client";

const URL = import.meta.env.VITE_SERVER_URL || "http://localhost:5000";

// Single shared socket instance
export const socket = io(URL, { autoConnect: false });
export const SERVER_URL = URL;
