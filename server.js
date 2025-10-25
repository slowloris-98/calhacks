const { createServer } = require("http");
const { Server } = require("socket.io");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// In-memory room store (use Redis in production)
const rooms = new Map();

// --- AI SYSTEM PROMPT (structured JSON) ---
const AI_SYSTEM_PROMPT = `
You are an AI participant in a multi-user chat. Multiple humans speak in any order.
Decide if you should reply now. DO NOT always reply.
Rules:
1) Reply if: (a) @ai or your name is mentioned, (b) you’re asked a direct question, (c) there’s conflict you can mediate,
   (d) 8+ seconds of silence after new info, (e) multiple users ask the same thing, (f) a newcomer joins and nobody greets them.
2) If no reply is needed, set "should_reply": false and suggest "next_wakeup_ms".
3) Target one or more addressees: specific users or "room".
4) Keep replies 2–3 sentences, cite users by name for clarity.
5) Maintain a running 1–2 sentence room summary. Update it sparingly.
6) Extract durable facts about users as memory updates.
Return ONLY valid JSON per the schema:
{
  "should_reply": true,
  "targets": ["@Ava","room"],
  "reply_style": "concise|mediator|guide|humor",
  "reply": "string",
  "summary_update": "string|null",
  "memory_updates": [],
  "next_wakeup_ms": 1500
}`;

// --- Helper: Call JanitorAI ---
async function callJanitorAI(messages) {
  const response = await fetch("https://janitorai.com/hackathon/completions", {
    method: "POST",
    headers: { Authorization: "calhacks2047", "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "system", content: AI_SYSTEM_PROMPT }, ...messages],
    }),
  });

  const data = await response.json();
  const raw = data.choices[0].message.content;
  try {
    return JSON.parse(raw);
  } catch {
    // fallback if model outputs text
    return { should_reply: true, targets: ["room"], reply: raw, reply_style: "concise" };
  }
}

// --- Helper: Build conversation context ---
function buildConversationContext(roomMessages, maxMessages = 50) {
  const recent = roomMessages.slice(-maxMessages);
  return recent.map((msg) => ({
    role: msg.isAI ? "assistant" : "user",
    content: msg.isAI ? msg.content : `[${msg.username}]: ${msg.content}`,
  }));
}

// --- Helper: Trigger AI logic per room ---
async function triggerAI(roomId, io) {
  const room = rooms.get(roomId);
  if (!room) return;

  const context = buildConversationContext(room.messages);
  context.unshift({
    role: "user",
    content: `[ROOM_SUMMARY]: ${room.summary || "Chat just started."}\n[PARTICIPANTS]: ${room.users
      .map((u) => u.username)
      .join(", ")}`,
  });

  const decision = await callJanitorAI(context);

  console.log("AI Decision", decision);
  console.log("AI should_reply", decision?.should_reply);

  // Skip if AI decides not to reply
  if (!decision?.should_reply) {
    room.aiWakeAt = Date.now() + (decision.next_wakeup_ms || 4000);
    room.pendingHumanBurst = [];
    console.log("AI skips reply, sets wakeup at", room.aiWakeAt);
    return;
  }

  if (decision.summary_update) room.summary = decision.summary_update;

  // ✅ Ensure plain-text reply even if model returns full JSON
  let replyText = "";
  if (typeof decision.reply === "string" && decision.reply.trim()) {
    replyText = decision.reply.trim();
  } else {
    // fallback: use a default message if reply is empty or invalid
    replyText = "I'm here if you need me!";
  }

  // ✅ Remove any accidental JSON braces or extra characters
  replyText = replyText.replace(/^[{\[]+|[}\]]+$/g, "").trim();

  const { nanoid } = await import("nanoid");
  const aiMessage = {
    id: nanoid(),
    content: replyText, // ✅ emit only text
    username: "AI Assistant",
    timestamp: Date.now(),
    isAI: true,
  };

  console.log("AI Message", aiMessage);

  room.messages.push(aiMessage);
  io.to(roomId).emit("message", aiMessage); // ✅ UI now gets clean text only
  room.pendingHumanBurst = [];
  room.aiWakeAt = Date.now() + 1500;
}

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("joinRoom", (data) => {
      const { roomId, username } = data;
      if (!roomId || !username) {
        socket.emit("error", "Room ID and username required");
        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          messages: [],
          users: [],
          summary: "Room just started.",
          aiWakeAt: 0,
          pendingHumanBurst: [],
        });
      }

      const room = rooms.get(roomId);
      const user = { id: socket.id, username, roomId };

      room.users.push(user);
      socket.join(roomId);
      socket.user = user;

      socket.to(roomId).emit("userJoined", user);
      socket.emit("roomUsers", room.users);
      room.messages.slice(-50).forEach((msg) => socket.emit("message", msg));

      console.log(`User ${username} joined room ${roomId}`);
    });

    socket.on("sendMessage", async ({ content, username, roomId }) => {
      const room = rooms.get(roomId);
      if (!room) {
        socket.emit("error", "Room not found");
        return;
      }

      const { nanoid } = await import("nanoid");
      const userMsg = {
        id: nanoid(),
        content,
        username,
        timestamp: Date.now(),
        isAI: false,
      };

      room.messages.push(userMsg);
      io.to(roomId).emit("message", userMsg);

      // --- Decide if AI should respond ---
      const isMention = /(^|\s)@(?:ai|assistant)\b/i.test(content);
      const isQuestion = /\?\s*$/.test(content);
      const due = Date.now() >= (room.aiWakeAt || 0);
      const triggerNow = isMention || isQuestion || due;

      if (!triggerNow) {
        clearTimeout(room.debounceTimer);
        room.debounceTimer = setTimeout(() => triggerAI(roomId, io), 800);
      } else {
        triggerAI(roomId, io);
      }
    });

    socket.on("leaveRoom", (roomId) => {
      if (!socket.user) return;
      const room = rooms.get(roomId);
      if (room) {
        room.users = room.users.filter((u) => u.id !== socket.id);
        socket.to(roomId).emit("userLeft", socket.id);
        if (room.users.length === 0) rooms.delete(roomId);
      }
      socket.leave(roomId);
      socket.user = null;
    });

    socket.on("disconnect", () => {
      if (socket.user) {
        const { roomId } = socket.user;
        const room = rooms.get(roomId);
        if (room) {
          room.users = room.users.filter((u) => u.id !== socket.id);
          socket.to(roomId).emit("userLeft", socket.id);
          if (room.users.length === 0) rooms.delete(roomId);
        }
      }
      console.log("User disconnected:", socket.id);
    });
  });

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
