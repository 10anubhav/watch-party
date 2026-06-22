import { Routes, Route } from "react-router-dom";
import Home from "./components/Home.jsx";
import Room from "./components/Room.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:roomId" element={<Room />} />
    </Routes>
  );
}
