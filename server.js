const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = { users: Map<socketId, { id, name }>, videoState: { url, playing, currentTime, updatedAt } }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      users: new Map(),
      videoState: {
        url: '',
        playing: false,
        currentTime: 0,
        updatedAt: Date.now()
      }
    };
  }
  return rooms[roomId];
}

function getRoomUsers(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return Array.from(room.users.values());
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  let currentRoom = null;

  // Join a room
  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;

    currentRoom = roomId;
    const room = getRoom(roomId);

    const user = { id: socket.id, name };
    room.users.set(socket.id, user);
    socket.join(roomId);

    // Send the new user the current room state.
    // If the video is playing, estimate the current position by adding the
    // time elapsed since the last sync event so the new joiner doesn't
    // restart from a stale timestamp.
    const videoStateForJoiner = { ...room.videoState };
    if (videoStateForJoiner.playing && videoStateForJoiner.updatedAt) {
      const elapsedSeconds = (Date.now() - videoStateForJoiner.updatedAt) / 1000;
      videoStateForJoiner.currentTime = videoStateForJoiner.currentTime + elapsedSeconds;
    }
    socket.emit('room-state', {
      users: getRoomUsers(roomId),
      videoState: videoStateForJoiner
    });

    // Notify others that a new user joined
    socket.to(roomId).emit('user-joined', { user });

    console.log(`[join] ${name} (${socket.id}) -> room ${roomId}`);
  });

  // WebRTC signaling: offer
  socket.on('rtc-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('rtc-offer', {
      fromId: socket.id,
      offer
    });
  });

  // WebRTC signaling: answer
  socket.on('rtc-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('rtc-answer', {
      fromId: socket.id,
      answer
    });
  });

  // WebRTC signaling: ICE candidate
  socket.on('rtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('rtc-ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // Video state sync: play, pause, seek, url change
  socket.on('video-sync', ({ roomId, action, currentTime, url }) => {
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    // Update server-side video state
    if (action === 'set-url') {
      room.videoState.url = url || '';
      room.videoState.playing = false;
      room.videoState.currentTime = 0;
    } else if (action === 'play') {
      room.videoState.playing = true;
      room.videoState.currentTime = currentTime || room.videoState.currentTime;
    } else if (action === 'pause') {
      room.videoState.playing = false;
      room.videoState.currentTime = currentTime || room.videoState.currentTime;
    } else if (action === 'seek') {
      room.videoState.currentTime = currentTime || 0;
    }
    room.videoState.updatedAt = Date.now();

    // Relay to everyone else in the room
    socket.to(roomId).emit('video-sync', {
      action,
      currentTime,
      url,
      fromId: socket.id
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      room.users.delete(socket.id);

      io.to(currentRoom).emit('user-left', { userId: socket.id });

      // Clean up empty rooms
      if (room.users.size === 0) {
        delete rooms[currentRoom];
        console.log(`[room-cleanup] ${currentRoom}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WatchTogether server running at http://localhost:${PORT}`);
});
