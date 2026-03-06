const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Game State ────────────────────────────────────────────────────
const rooms = new Map();
const WIN_LINES = 3;

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function countLines(card, calledSet) {
  if (!card) return 0;
  if (card.flat().some(n => n === 0)) return 0;
  const m = card.map(row => row.map(n => calledSet.has(n)));
  let count = 0;
  for (let r = 0; r < 5; r++) if (m[r].every(Boolean)) count++;
  for (let c = 0; c < 5; c++) if (m.every(row => row[c])) count++;
  if ([0, 1, 2, 3, 4].every(i => m[i][i])) count++;
  if ([0, 1, 2, 3, 4].every(i => m[i][4 - i])) count++;
  return count;
}

function validateCard(card) {
  if (!Array.isArray(card) || card.length !== 5) return false;
  const nums = card.flat();
  if (nums.length !== 25) return false;
  if (nums.some(n => typeof n !== 'number' || n < 1 || n > 25)) return false;
  if (new Set(nums).size !== 25) return false;
  return true;
}

function getRoomBySocket(socketId) {
  for (const [code, room] of rooms) {
    if (room.hostId === socketId || room.guestId === socketId) return { code, room };
  }
  return null;
}

function getOpponentId(room, socketId) {
  return room.hostId === socketId ? room.guestId : room.hostId;
}

// Reset room state for a new round — keep players, wipe game data
function resetRoomForNewGame(room) {
  room.cards = {};
  room.ready = {};
  room.called = new Set();
  room.phase = 'setup';
  room.winner = null;
  room.playAgain = {};  // track who clicked play again
}

function cleanupOldRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) rooms.delete(code);
  }
}
setInterval(cleanupOldRooms, 30 * 60 * 1000);

// ── Socket Events ─────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────────
  socket.on('create_room', () => {
    const existing = getRoomBySocket(socket.id);
    if (existing) { socket.leave(existing.code); rooms.delete(existing.code); }
    const code = genCode();
    rooms.set(code, {
      code, hostId: socket.id, guestId: null,
      cards: {}, ready: {}, called: new Set(),
      phase: 'waiting', winner: null,
      playAgain: {},
      createdAt: Date.now()
    });
    socket.join(code);
    socket.emit('room_created', { code });
    console.log(`[Room] Created: ${code}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────
  socket.on('join_room', ({ code }) => {
    const upperCode = (code || '').toUpperCase().trim();
    const room = rooms.get(upperCode);
    if (!room) return socket.emit('error', { msg: 'Room not found. Check the code and try again.' });
    if (room.phase !== 'waiting') return socket.emit('error', { msg: 'This game is already in progress.' });
    if (room.guestId) return socket.emit('error', { msg: 'Room is full (2 players max).' });
    if (room.hostId === socket.id) return socket.emit('error', { msg: 'You cannot join your own room.' });

    room.guestId = socket.id;
    room.phase = 'setup';
    socket.join(upperCode);
    socket.emit('room_joined', { code: upperCode });
    io.to(upperCode).emit('both_connected', {
      code: upperCode, hostId: room.hostId, guestId: room.guestId
    });
    console.log(`[Room] ${socket.id} joined ${upperCode}`);
  });

  // ── SUBMIT CARD ──────────────────────────────────────────────
  socket.on('submit_card', ({ card }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return socket.emit('error', { msg: 'You are not in a room.' });
    const { code, room } = found;
    if (room.phase !== 'setup') return socket.emit('error', { msg: 'Cannot submit card now.' });
    if (!validateCard(card)) return socket.emit('error', { msg: 'Invalid card. Use numbers 1–25, each once.' });

    room.cards[socket.id] = card;
    room.ready[socket.id] = true;
    socket.emit('card_accepted');

    const bothReady = room.hostId && room.guestId &&
      room.ready[room.hostId] && room.ready[room.guestId];

    if (bothReady) {
      room.phase = 'playing';
      io.to(room.hostId).emit('game_start', {
        myCard: room.cards[room.hostId], oppCard: room.cards[room.guestId],
        called: [], myId: room.hostId, winLines: WIN_LINES
      });
      io.to(room.guestId).emit('game_start', {
        myCard: room.cards[room.guestId], oppCard: room.cards[room.hostId],
        called: [], myId: room.guestId, winLines: WIN_LINES
      });
      console.log(`[Game] Started in room ${code}`);
    } else {
      socket.emit('waiting_for_opponent');
      const oppId = getOpponentId(room, socket.id);
      if (oppId) io.to(oppId).emit('opponent_ready');
    }
  });

  // ── CALL NUMBER ──────────────────────────────────────────────
  socket.on('call_number', ({ num }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.phase !== 'playing') return socket.emit('error', { msg: 'Game is not in progress.' });
    if (typeof num !== 'number' || num < 1 || num > 25) return socket.emit('error', { msg: 'Invalid number.' });
    if (room.called.has(num)) return socket.emit('error', { msg: 'Number already called.' });

    room.called.add(num);
    const calledArr = [...room.called];
    const hostLines = countLines(room.cards[room.hostId], room.called);
    const guestLines = countLines(room.cards[room.guestId], room.called);

    if (hostLines >= WIN_LINES || guestLines >= WIN_LINES) {
      room.phase = 'gameover';
      room.winner = hostLines >= WIN_LINES ? room.hostId : room.guestId;

      io.to(code).emit('number_called', { num, called: calledArr });

      io.to(room.hostId).emit('game_over', {
        winnerId: room.winner, myId: room.hostId,
        myCard: room.cards[room.hostId], oppCard: room.cards[room.guestId],
        called: calledArr, myLines: hostLines, oppLines: guestLines
      });
      io.to(room.guestId).emit('game_over', {
        winnerId: room.winner, myId: room.guestId,
        myCard: room.cards[room.guestId], oppCard: room.cards[room.hostId],
        called: calledArr, myLines: guestLines, oppLines: hostLines
      });
      console.log(`[Game] Room ${code} — winner: ${room.winner}`);
    } else {
      io.to(room.hostId).emit('number_called', { num, called: calledArr, myLines: hostLines, oppLines: guestLines });
      io.to(room.guestId).emit('number_called', { num, called: calledArr, myLines: guestLines, oppLines: hostLines });
    }
  });

  // ── PLAY AGAIN ───────────────────────────────────────────────
  socket.on('play_again', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return socket.emit('error', { msg: 'You are not in a room.' });
    const { code, room } = found;
    if (room.phase !== 'gameover') return;

    // Mark this player as wanting to play again
    if (!room.playAgain) room.playAgain = {};
    room.playAgain[socket.id] = true;

    const oppId = getOpponentId(room, socket.id);

    // Notify opponent that this player wants to play again
    if (oppId) io.to(oppId).emit('opponent_wants_rematch');

    const bothWant = room.playAgain[room.hostId] && room.playAgain[room.guestId];
    if (bothWant) {
      // Reset room and start setup for both
      resetRoomForNewGame(room);
      io.to(code).emit('rematch_start');
      console.log(`[Room] Rematch started in ${code}`);
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    const oppId = getOpponentId(room, socket.id);
    if (oppId && room.phase !== 'gameover') {
      io.to(oppId).emit('opponent_disconnected');
    } else if (oppId && room.phase === 'gameover') {
      // Opponent left from game over screen — notify if they're still there
      io.to(oppId).emit('opponent_left_after_game');
    }
    rooms.delete(code);
    console.log(`[Room] Deleted ${code}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✦ Bingo server → http://localhost:${PORT}  (win = ${WIN_LINES} lines)\n`);
});