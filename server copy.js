const { createServer } = require("http");
const { Server } = require("socket.io");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = process.env.PORT || 3000;

// Initialize Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Store rooms in memory (in production, use Redis or database)
const rooms = new Map();

// AI system prompt
const AI_SYSTEM_PROMPT = `You are a friendly AI assistant in a group chat room. Multiple users are chatting together, and you're part of the conversation. Keep responses concise (2-3 sentences), engaging, and contextually aware of the group dynamic. Address users by name when relevant. Be helpful, fun, and maintain conversation flow.`;

// Function to call JanitorAI API
async function callJanitorAI(messages) {
  try {
    const response = await fetch(
      "https://janitorai.com/hackathon/completions",
      {
        method: "POST",
        headers: {
          Authorization: "calhacks2047",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: AI_SYSTEM_PROMPT },
            ...messages,
          ],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error("AI API error:", error);
    return "Sorry, I'm having trouble responding right now!";
  }
}

// Function to build conversation context
function buildConversationContext(roomMessages, maxMessages = 50) {
  const recentMessages = roomMessages.slice(-maxMessages);
  return recentMessages.map((msg) => ({
    role: msg.isAI ? "assistant" : "user",
    content: msg.isAI ? msg.content : `[${msg.username}]: ${msg.content}`,
  }));
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Join room
    socket.on("joinRoom", async (data) => {
      const { roomId, username } = data;

      if (!roomId || !username) {
        socket.emit("error", "Room ID and username are required");
        return;
      }

      // Get or create room
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          messages: [],
          users: [],
          createdAt: Date.now(),
        });
      }

      const room = rooms.get(roomId);
      const user = {
        id: socket.id,
        username,
        roomId,
      };

      // Add user to room
      room.users.push(user);
      socket.join(roomId);
      socket.user = user;

      // Notify room about new user
      socket.to(roomId).emit("userJoined", user);

      // Send current room users to the new user
      socket.emit("roomUsers", room.users);

      // Send recent messages to the new user
      room.messages.slice(-50).forEach((message) => {
        socket.emit("message", message);
      });

      console.log(`User ${username} joined room ${roomId}`);
    });

    // Send message
    socket.on("sendMessage", async (data) => {
      const { content, username, roomId } = data;

      if (!socket.user || !roomId) {
        socket.emit("error", "Not in a room");
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        socket.emit("error", "Room not found");
        return;
      }

      // Create user message
      const { nanoid } = await import("nanoid");
      const userMessage = {
        id: nanoid(),
        content,
        username,
        timestamp: Date.now(),
        isAI: false,
      };

      // Add message to room
      room.messages.push(userMessage);

      // Broadcast user message to all users in room
      io.to(roomId).emit("message", userMessage);

      // Generate AI response
      try {
        const conversationContext = buildConversationContext(room.messages);
        const aiResponse = await callJanitorAI(conversationContext);

        // Add small delay to simulate natural response time
        setTimeout(async () => {
          const { nanoid } = await import("nanoid");
          const aiMessage = {
            id: nanoid(),
            content: aiResponse,
            username: "AI Assistant",
            timestamp: Date.now(),
            isAI: true,
          };

          room.messages.push(aiMessage);
          io.to(roomId).emit("message", aiMessage);
        }, 1000 + Math.random() * 1000); // 1-2 second delay
      } catch (error) {
        console.error("Error generating AI response:", error);
      }
    });

    // Leave room
    socket.on("leaveRoom", (roomId) => {
      if (socket.user && roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.users = room.users.filter((user) => user.id !== socket.id);
          socket.to(roomId).emit("userLeft", socket.id);

          // Clean up empty rooms
          if (room.users.length === 0) {
            rooms.delete(roomId);
          }
        }
        socket.leave(roomId);
        socket.user = null;
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      if (socket.user) {
        const { roomId } = socket.user;
        const room = rooms.get(roomId);

        if (room) {
          room.users = room.users.filter((user) => user.id !== socket.id);
          socket.to(roomId).emit("userLeft", socket.id);

          // Clean up empty rooms
          if (room.users.length === 0) {
            rooms.delete(roomId);
          }
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
