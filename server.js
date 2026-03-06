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
  },
  maxHttpBufferSize: 4e6  // 4 MB – comfortable headroom for 256 KB binary video chunks
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = {
//   users:     Map<socketId, { id, name }>,
//   operators: Set<socketId>,          ← NEW: set of operator socket IDs
//   videoState: { url, playing, currentTime, updatedAt }
// }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      users: new Map(),
      operators: new Set(),
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

// Fire 'video-all-ready' once every client in the room has confirmed receipt.
function checkAllReady(roomId, uploadId) {
  const room = rooms[roomId];
  if (!room || !room.pendingUpload || room.pendingUpload.uploadId !== uploadId) return;
  const clientIds = Array.from(room.users.keys());
  if (clientIds.every(id => room.pendingUpload.readyClients.has(id))) {
    io.to(roomId).emit('video-all-ready', { uploadId });
    room.pendingUpload = null;
    console.log(`[upload] ${uploadId} confirmed ready for all clients in ${roomId}`);
  }
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

    // First person into the room becomes operator automatically.
    // Subsequent joiners are plain participants until promoted.
    if (room.users.size === 1) {
      room.operators.add(socket.id);
    }

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
      operators: Array.from(room.operators),
      videoState: videoStateForJoiner
    });

    // Notify others that a new user joined (include current operator list)
    socket.to(roomId).emit('user-joined', {
      user,
      operators: Array.from(room.operators)
    });

    console.log(`[join] ${name} (${socket.id}) -> room ${roomId} [operator: ${room.operators.has(socket.id)}]`);
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
  // Only operators are permitted to send these events.
  socket.on('video-sync', ({ roomId, action, currentTime, url }) => {
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    // Reject sync commands from non-operators
    if (!room.operators.has(socket.id)) return;

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

  // Operator assigns another participant as operator.
  // Only existing operators may promote others.
  socket.on('assign-operator', ({ roomId, targetId }) => {
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    if (!room.operators.has(socket.id)) return;       // caller must be operator
    if (!room.users.has(targetId)) return;             // target must be in room

    room.operators.add(targetId);
    console.log(`[operator] ${targetId} promoted by ${socket.id} in room ${roomId}`);

    io.to(roomId).emit('operators-changed', {
      operators: Array.from(room.operators)
    });
  });

  // ── Video file upload relay ──────────────────────────────────────────────────

  // Operator announces a new local-file upload to the room.
  socket.on('video-upload-announce', ({ uploadId, filename, mimeType, size, totalChunks }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.operators.has(socket.id)) return;

    room.pendingUpload = {
      uploadId,
      filename,
      mimeType,
      size,
      totalChunks,
      uploaderId: socket.id,
      readyClients: new Set([socket.id]) // uploader already has the file
    };

    socket.to(currentRoom).emit('video-upload-announce', { uploadId, filename, mimeType, size, totalChunks });
    console.log(`[upload] "${filename}" (${Math.round(size / 1024)} KB, ${totalChunks} chunks) in room ${currentRoom}`);

    // Handle single-client room: operator is the only user – fire ready immediately.
    checkAllReady(currentRoom, uploadId);
  });

  // Relay a raw binary chunk from the operator to every other client.
  socket.on('video-chunk', ({ uploadId, index, data }, ack) => {
    if (!currentRoom || !rooms[currentRoom]) { if (ack) ack(); return; }
    if (!rooms[currentRoom].operators.has(socket.id)) { if (ack) ack(); return; }
    socket.to(currentRoom).emit('video-chunk', { uploadId, index, data });
    if (ack) ack(); // signal operator the chunk was accepted, safe to send next
  });

  // A client signals it has fully received and stored the video in its PouchDB.
  socket.on('video-client-ready', ({ uploadId }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.pendingUpload || room.pendingUpload.uploadId !== uploadId) return;
    room.pendingUpload.readyClients.add(socket.id);
    console.log(`[upload] client ${socket.id} ready for "${uploadId}" in ${currentRoom}`);
    checkAllReady(currentRoom, uploadId);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const wasOperator = room.operators.has(socket.id);

      room.users.delete(socket.id);
      room.operators.delete(socket.id);

      io.to(currentRoom).emit('user-left', { userId: socket.id });

      // Clean up empty rooms
      if (room.users.size === 0) {
        delete rooms[currentRoom];
        console.log(`[room-cleanup] ${currentRoom}`);
      } else if (wasOperator && room.operators.size === 0) {
        // Operator left and no operators remain – pick a random participant
        const remaining = Array.from(room.users.keys());
        const newOp = remaining[Math.floor(Math.random() * remaining.length)];
        room.operators.add(newOp);
        console.log(`[operator] ${newOp} auto-promoted in room ${currentRoom}`);

        io.to(currentRoom).emit('operators-changed', {
          operators: Array.from(room.operators)
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WatchTogether server running at http://localhost:${PORT}`);
});
