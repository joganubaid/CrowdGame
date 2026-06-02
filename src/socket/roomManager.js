const { db } = require('../services/db');
const redisService = require('../services/redis');
const crypto = require('crypto');

const NEON_COLORS = [
  '#ff007f', // Neon Pink
  '#00f3ff', // Neon Cyan
  '#ffb800', // Neon Yellow
  '#39ff14', // Neon Green
  '#9d00ff', // Neon Purple
  '#ff4500', // Neon Orange-Red
  '#e0b0ff', // Mauve Neon
  '#ff00ff'  // Magenta
];

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomCode -> roomState
    
    // Subscribe to Redis pubsub if Redis is running for multi-server synchronization
    if (!redisService.isMock()) {
      this.initRedisPubSub();
    }
  }

  initRedisPubSub() {
    const pubSubClient = redisService.client.duplicate();
    pubSubClient.connect().then(() => {
      pubSubClient.subscribe('room_updates', (message) => {
        const { roomCode, type, data } = JSON.parse(message);
        // Handle cross-server room updates if needed
        // For simple deployment, single node or sticky sessions with Socket.io redis adapter is sufficient
      });
    });
  }

  // Generate a random unique 4-character room code
  generateRoomCode() {
    let code;
    do {
      code = crypto.randomBytes(2).toString('hex').toUpperCase();
    } while (this.rooms.has(code));
    return code;
  }

  // Create a room (Big Screen registers as host)
  async createRoom(hostSocketId, customCode = null) {
    const roomCode = customCode ? customCode.toUpperCase() : this.generateRoomCode();
    const roomId = crypto.randomUUID();
    
    const roomState = {
      id: roomId,
      roomCode,
      hostSocketId,
      status: 'waiting', // waiting, active, completed
      participants: new Map(), // playerId -> participant object
      activity: null,
      createdAt: new Date()
    };

    this.rooms.set(roomCode, roomState);

    // Save to Database asynchronously if DB is configured
    if (db) {
      db('rooms')
        .insert({
          id: roomId,
          room_code: roomCode,
          activity_type: 'jigsaw',
          status: 'waiting',
          created_at: new Date()
        })
        .onConflict('room_code')
        .merge()
        .catch(err => console.error('DB error saving room:', err));
    }

    console.log(`Room created: ${roomCode} with ID: ${roomId}`);
    return roomState;
  }

  getRoom(roomCode) {
    if (!roomCode) return null;
    return this.rooms.get(roomCode.toUpperCase());
  }

  // Add participant to room
  joinRoom(roomCode, socketId, displayName) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    // Limit participants per room for performance stability (e.g. max 100)
    if (room.participants.size >= 100) {
      return { success: false, error: 'Room is full' };
    }

    const playerId = crypto.createHash('md5').update(displayName.toLowerCase().trim()).digest('hex');
    
    // Check if participant already exists in the room (handles reconnection)
    let participant = room.participants.get(playerId);
    
    if (participant) {
      // Reconnection
      participant.socketId = socketId;
      participant.isConnected = true;
      console.log(`Player ${displayName} reconnected to room ${roomCode}`);
    } else {
      // New Player Join
      const color = NEON_COLORS[room.participants.size % NEON_COLORS.length];
      participant = {
        id: playerId,
        displayName,
        color,
        socketId,
        score: 0,
        isConnected: true,
        joinedAt: new Date()
      };
      room.participants.set(playerId, participant);
      console.log(`Player ${displayName} joined room ${roomCode}`);

      // Save to database
      if (db) {
        db('participants').insert({
          id: crypto.randomUUID(),
          room_id: room.id,
          display_name: displayName,
          color: color,
          socket_id: socketId,
          score: 0,
          is_connected: true
        }).catch(err => console.error('DB error saving participant:', err));
      }
    }

    // Trigger activity player join callback
    if (room.activity) {
      room.activity.onPlayerJoin(participant);
    }

    // Notify host/big screen
    this.io.to(room.hostSocketId).emit('player-joined', {
      id: participant.id,
      displayName: participant.displayName,
      color: participant.color,
      score: participant.score,
      count: this.getConnectedCount(roomCode)
    });

    return { success: true, participant };
  }

  getConnectedCount(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return 0;
    return Array.from(room.participants.values()).filter(p => p.isConnected).length;
  }

  // Handle participant disconnection
  handleDisconnect(socketId) {
    for (const [roomCode, room] of this.rooms.entries()) {
      // 1. Check if host disconnected
      if (room.hostSocketId === socketId) {
        console.log(`Host disconnected from room: ${roomCode}`);
        
        // Notify all participants
        this.io.to(roomCode).emit('host-disconnected');
        
        // Delete the room
        this.rooms.delete(roomCode);
        
        if (db) {
          db('rooms')
            .where({ id: room.id })
            .update({ status: 'completed', completed_at: new Date() })
            .catch(err => console.error('DB error updating room status:', err));
        }
        return;
      }

      // 2. Check if a participant disconnected
      for (const [playerId, p] of room.participants.entries()) {
        if (p.socketId === socketId) {
          console.log(`Player ${p.displayName} disconnected from room: ${roomCode}`);
          p.isConnected = false;
          
          if (room.activity) {
            room.activity.onPlayerLeave(p);
          }

          // Update database
          if (db) {
            db('participants')
              .where({ socket_id: socketId })
              .update({ is_connected: false })
              .catch(err => console.error('DB error updating participant connection:', err));
          }

          // Notify host/big screen
          this.io.to(room.hostSocketId).emit('player-left', {
            id: p.id,
            displayName: p.displayName,
            count: this.getConnectedCount(roomCode)
          });
          
          return;
        }
      }
    }
  }

  // Start activity inside a room
  async startActivity(roomCode, activityType, activityConfig = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { success: false, error: 'Room not found' };

    room.status = 'active';

    // Dynamically instantiate activity class
    let ActivityClass;
    if (activityType === 'jigsaw') {
      ActivityClass = require('../activities/jigsaw');
    } else if (activityType === 'wordcloud') {
      ActivityClass = require('../activities/wordcloud');
    } else {
      return { success: false, error: 'Unknown activity type' };
    }

    const activityInstance = new ActivityClass(roomCode, activityConfig, this);
    await activityInstance.onStart();
    room.activity = activityInstance;
    room.activityType = activityType; // so late joiners learn which mode is live

    // Trigger onPlayerJoin for already connected players
    room.participants.forEach(p => {
      if (p.isConnected) {
        activityInstance.onPlayerJoin(p);
      }
    });

    if (db) {
      db('rooms')
        .where({ id: room.id })
        .update({ status: 'active', activity_type: activityType, started_at: new Date() })
        .catch(err => console.error('DB error starting room activity:', err));
    }

    // Sync room to Redis
    this.syncRoomToRedis(roomCode);

    return { success: true };
  }

  // Sync state to Redis cache
  async syncRoomToRedis(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return;

    const data = {
      id: room.id,
      roomCode: room.roomCode,
      status: room.status,
      participantCount: room.participants.size,
      progress: room.activity ? room.activity.getProgress() : 0
    };

    redisService.client.set(`room:${roomCode}`, JSON.stringify(data), { EX: 86400 }) // Expire in 1 day
      .catch(err => console.error('Redis error syncing room:', err));
  }
}

module.exports = RoomManager;
