const jwt = require('jsonwebtoken');
const config = require('../config');
const RoomManager = require('./roomManager');

function initSockets(io) {
  const roomManager = new RoomManager(io);

  // ─── Admin Auth Middleware ─────────────────────────────────────────────────
  // Sockets that supply a valid admin JWT in socket.handshake.auth.token get
  // socket.isAdmin = true.  All other sockets are treated as regular clients.
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token) {
      try {
        const payload = jwt.verify(token, config.JWT_SECRET);
        if (payload.role === 'admin') {
          socket.isAdmin = true;
        }
      } catch (_) {
        // Token present but invalid — continue as regular client (don't reject,
        // because mobile players connect without any token at all)
      }
    }
    next();
  });

  io.on('connection', (socket) => {
    // console.log(`Socket connection: ${socket.id}`);

    // 1. Host Room creation (Desktop Big Screen or Admin pre-init)
    socket.on('host-room', async (roomCode) => {
      console.log(`Host connection request. Custom room code: ${roomCode}`);
      try {
        // If the room already exists (admin pre-created it via the admin panel),
        // don't wipe it — just transfer the display host to this socket.
        const existingRoom = roomManager.getRoom(roomCode);

        let room;
        if (existingRoom) {
          existingRoom.hostSocketId = socket.id;
          // Cancel any pending close from a brief host disconnect (e.g. refresh).
          if (existingRoom.closeTimer) {
            clearTimeout(existingRoom.closeTimer);
            existingRoom.closeTimer = null;
          }
          room = existingRoom;
          console.log(`Screen display reconnected to existing room: ${roomCode}`);
        } else {
          room = await roomManager.createRoom(socket.id, roomCode);
        }

        socket.join(room.roomCode);
        socket.roomCode = room.roomCode;
        socket.role = 'host';

        socket.emit('room-created', {
          roomCode: room.roomCode,
          status: room.status
        });

        // If the activity was already started (admin started before screen opened),
        // push the current full activity state to the screen immediately.
        if (room.activity) {
          socket.emit('activity-start', {
            type: room.activityType || 'jigsaw',
            state: room.activity.getStateForScreen()
          });
        }
      } catch (err) {
        console.error('Error in host-room setup:', err);
        socket.emit('error-message', 'Failed to create room.');
      }
    });

    // 2. Mobile Player joins room
    socket.on('join-room', ({ roomCode, displayName }) => {
      roomCode = roomCode.toUpperCase();
      console.log(`Player '${displayName}' requesting join for Room: ${roomCode}`);

      const result = roomManager.joinRoom(roomCode, socket.id, displayName);
      if (!result.success) {
        socket.emit('error-message', result.error);
        return;
      }

      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.role = 'player';
      socket.playerId = result.participant.id;

      socket.emit('joined-successfully', {
        playerId: result.participant.id,
        color: result.participant.color,
        displayName: result.participant.displayName
      });

      // Broadcast updated participant list to everyone in the room
      const room = roomManager.getRoom(roomCode);
      io.to(roomCode).emit('room-update', {
        status: room.status,
        participantsCount: roomManager.getConnectedCount(roomCode)
      });

      // If activity is already running, send the starting state immediately to the new player
      if (room.activity) {
        socket.emit('activity-start', {
          type: room.activityType || 'jigsaw',
          state: room.activity.getStateForPlayer(socket.playerId)
        });
      }
    });

    // 3. Admin / Host starts activity
    // ── Auth guard ────────────────────────────────────────────────────────────
    // The requesting socket must either:
    //   a) carry a valid admin JWT (socket.isAdmin), OR
    //   b) be the registered host socket for that room.
    // This prevents any arbitrary player from starting or restarting the game.
    socket.on('admin-start-activity', async (payload = {}) => {
      // `activityType` defaults to jigsaw so older clients (which send only
      // rows/cols/imageUrl) keep working unchanged.
      const { roomCode, activityType = 'jigsaw' } = payload;
      console.log(`Admin requested '${activityType}' activity start in room: ${roomCode}`);

      const room = roomManager.getRoom(roomCode);
      if (!room) {
        socket.emit('error-message', 'Room not found.');
        return;
      }

      // ── Authorization check ──
      const isRoomHost = socket.id === room.hostSocketId;
      if (!socket.isAdmin && !isRoomHost) {
        console.warn(`Unauthorized admin-start-activity attempt from socket ${socket.id}`);
        socket.emit('error-message', 'Unauthorized: only the room host or admin can start an activity.');
        return;
      }

      // Build the per-activity config from the relevant payload fields.
      let activityConfig;
      if (activityType === 'wordcloud') {
        activityConfig = {
          prompt: payload.prompt,
          maxChars: payload.maxChars,
          maxSubmissions: payload.maxSubmissions
        };
      } else {
        activityConfig = {
          rows: parseInt(payload.rows) || 4,
          cols: parseInt(payload.cols) || 6,
          imageUrl: payload.imageUrl
        };
      }

      const result = await roomManager.startActivity(roomCode, activityType, activityConfig);
      if (!result.success) {
        socket.emit('error-message', result.error);
        return;
      }

      // Notify host and all players that the activity has started
      io.to(room.hostSocketId).emit('activity-start', {
        type: activityType,
        state: room.activity.getStateForScreen()
      });

      // Send personalized starting configurations to each player
      room.participants.forEach((p) => {
        if (p.isConnected && p.socketId) {
          io.to(p.socketId).emit('activity-start', {
            type: activityType,
            state: room.activity.getStateForPlayer(p.id)
          });
        }
      });
    });

    // 4. Jigsaw placement action from players
    socket.on('move-piece', (actionData) => {
      if (socket.role !== 'player' || !socket.roomCode) return;
      const room = roomManager.getRoom(socket.roomCode);
      if (!room || !room.activity || room.status !== 'active') return;

      const player = room.participants.get(socket.playerId);
      if (!player) return;

      const { pieceId, currentX, currentY } = actionData;
      const piece = room.activity.pieces.find(p => p.id === pieceId);
      if (piece && piece.assignedTo === player.id && !piece.isPlaced) {
        piece.currentX = currentX;
        piece.currentY = currentY;
        io.to(room.hostSocketId).emit('piece-move', { pieceId, currentX, currentY });
      }
    });

    socket.on('place-piece', (actionData) => {
      if (socket.role !== 'player' || !socket.roomCode) return;

      const room = roomManager.getRoom(socket.roomCode);
      if (!room || !room.activity || room.status !== 'active') return;

      const player = room.participants.get(socket.playerId);
      if (!player) return;

      const result = room.activity.onPlayerAction(player, 'place-piece', actionData);
      if (!result || !result.success) {
        socket.emit('error-message', result ? result.error : 'Action failed');
        return;
      }

      // If correct, broadcast placement update to all clients in the room
      if (result.correct) {
        io.to(socket.roomCode).emit('piece-placed', {
          pieceId: result.pieceId,
          correctX: result.correctX,
          correctY: result.correctY,
          placedBy: result.placedBy,
          score: result.score,
          progress: result.progress,
          isSolved: result.isSolved
        });

        // Send a fresh set of assigned pieces specifically to the placing player
        socket.emit('assign-pieces', {
          assignedPieces: room.activity.getStateForPlayer(socket.playerId).assignedPieces
        });

        // If solved, broadcast game completion
        if (result.isSolved) {
          // Sort participants by score for the final leaderboard
          const leaderboard = Array.from(room.participants.values())
            .map(p => ({ displayName: p.displayName, score: p.score, color: p.color }))
            .sort((a, b) => b.score - a.score);

          io.to(socket.roomCode).emit('activity-complete', {
            leaderboard,
            totalPieces: room.activity.totalPieces
          });

          room.status = 'completed';
        }
      } else {
        // Sync drag coordinates to the big screen for live visual feedback
        io.to(room.hostSocketId).emit('piece-move', {
          pieceId: result.pieceId,
          currentX: result.currentX,
          currentY: result.currentY
        });

        // Notify the player of the incorrect placement
        socket.emit('placement-incorrect', { pieceId: result.pieceId });
      }
    });

    // 5. Word Cloud: participant submits a text response
    socket.on('submit-response', (actionData) => {
      if (socket.role !== 'player' || !socket.roomCode) return;

      const room = roomManager.getRoom(socket.roomCode);
      if (!room || !room.activity || room.status !== 'active') return;

      const player = room.participants.get(socket.playerId);
      if (!player) return;

      const result = room.activity.onPlayerAction(player, 'submit-response', actionData);
      if (!result || !result.success) {
        socket.emit('error-message', result ? result.error : 'Submission failed.');
        return;
      }

      // Acknowledge to the submitter (drives the "submitted / remaining" UI).
      socket.emit('response-accepted', {
        hidden: result.hidden,
        remaining: result.remaining
      });

      // Push the refreshed cloud to the room. The big screen renders it and the
      // admin console uses it to moderate; players don't listen for this event.
      io.to(room.roomCode).emit('wordcloud-update', result.screenState);
    });

    // 6. Word Cloud: host/admin removes a response (moderation)
    socket.on('admin-remove-response', ({ roomCode, responseId } = {}) => {
      const room = roomManager.getRoom(roomCode);
      if (!room || !room.activity) return;

      const isRoomHost = socket.id === room.hostSocketId;
      if (!socket.isAdmin && !isRoomHost) {
        socket.emit('error-message', 'Unauthorized: only the room host or admin can remove responses.');
        return;
      }
      if (typeof room.activity.removeResponse !== 'function') return;

      const result = room.activity.removeResponse(responseId);
      if (result.success) {
        io.to(room.roomCode).emit('wordcloud-update', result.screenState);
      }
    });

    // 7. Word Cloud: participant upvotes a word
    socket.on('vote-word', (actionData) => {
      if (socket.role !== 'player' || !socket.roomCode) return;

      const room = roomManager.getRoom(socket.roomCode);
      if (!room || !room.activity || room.status !== 'active') return;

      const player = room.participants.get(socket.playerId);
      if (!player) return;

      const result = room.activity.onPlayerAction(player, 'vote-word', actionData);
      if (!result || !result.success) {
        socket.emit('error-message', result ? result.error : 'Vote failed.');
        return;
      }
      io.to(room.roomCode).emit('wordcloud-update', result.screenState);
    });

    // 8. Word Cloud: host/admin closes the session and reveals the summary
    socket.on('admin-close-activity', ({ roomCode } = {}) => {
      const room = roomManager.getRoom(roomCode);
      if (!room || !room.activity) return;

      const isRoomHost = socket.id === room.hostSocketId;
      if (!socket.isAdmin && !isRoomHost) {
        socket.emit('error-message', 'Unauthorized: only the room host or admin can close the session.');
        return;
      }
      if (typeof room.activity.close !== 'function') return;

      const summary = room.activity.close();
      room.status = 'completed';
      io.to(room.roomCode).emit('wordcloud-closed', summary);
    });

    // 9. Clean up on socket disconnect
    socket.on('disconnect', () => {
      roomManager.handleDisconnect(socket.id);
    });
  });
}

module.exports = initSockets;
