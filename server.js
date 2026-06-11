// ============================================================
// Khmer Card Game Server
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');
const path = require('path');

const G = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-Memory Stores ──────────────────────────────────────────
const users = {};   // userId -> { id, username, coins, diamonds, wins, losses }
const rooms = {};   // roomId -> RoomState
const sockets = {}; // socketId -> userId

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok:false, error:'Missing fields' });
  if (Object.values(users).find(u => u.username === username))
    return res.json({ ok:false, error:'Username taken' });
  const id = uuid();
  users[id] = { id, username, password, coins:1000, diamonds:50, wins:0, losses:0 };
  res.json({ ok:true, user: safeUser(users[id]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = Object.values(users).find(u => u.username === username && u.password === password);
  if (!user) return res.json({ ok:false, error:'Invalid credentials' });
  res.json({ ok:true, user: safeUser(user) });
});

function safeUser(u) {
  return { id:u.id, username:u.username, coins:u.coins, diamonds:u.diamonds, wins:u.wins, losses:u.losses };
}

// ── Room Helpers ──────────────────────────────────────────────
function publicRoom(r) {
  return {
    id: r.id,
    name: r.name,
    stakes: r.stakes,
    variant: r.variant,
    playerCount: r.players.length,
    maxPlayers: 4,
    phase: r.phase,
    players: r.players.map(p => ({ id:p.id, username:p.username, coins:p.coins, ready:p.ready }))
  };
}

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.phase === 'WAITING')
    .map(publicRoom);
}

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('auth', ({ userId }) => {
    if (!users[userId]) return;
    sockets[socket.id] = userId;
    users[userId].socketId = socket.id;
    socket.emit('room_list', getRoomList());
  });

  socket.on('create_room', ({ userId, stakes, roomName, variant }) => {
    const user = users[userId];
    if (!user) return socket.emit('error', 'Not logged in');
    leaveAllRooms(socket, userId);

    const id = uuid().slice(0,6).toUpperCase();
    const player = makePlayer(user, socket.id);
    rooms[id] = {
      id, name: roomName || `Room ${id}`,
      stakes: stakes || { coins: 10 },
      variant: variant === 'COMUNIS' ? 'COMUNIS' : 'FREE',
      phase: 'WAITING',
      players: [player],
      chat: [],
      game: null
    };
    socket.join(id);
    socket.emit('room_joined', publicRoom(rooms[id]));
    io.emit('room_list', getRoomList());
  });

  socket.on('join_room', ({ userId, roomId }) => {
    const user = users[userId];
    const room = rooms[roomId];
    if (!user) return socket.emit('error', 'Not logged in');
    if (!room) return socket.emit('error', 'Room not found');
    if (room.phase !== 'WAITING') return socket.emit('error', 'Game already started');
    if (room.players.length >= 4) return socket.emit('error', 'Room full');
    if (room.players.find(p => p.id === userId)) return socket.emit('error', 'Already in room');

    leaveAllRooms(socket, userId);
    room.players.push(makePlayer(user, socket.id));
    socket.join(roomId);

    // Send recent chat history to new joiner
    socket.emit('chat_history', room.chat.slice(-50));
    io.to(roomId).emit('room_updated', publicRoom(room));
    socket.emit('room_joined', publicRoom(room));
    io.emit('room_list', getRoomList());
  });

  socket.on('leave_room', ({ userId, roomId }) => {
    leaveRoom(socket, userId, roomId);
  });

  socket.on('start_game', ({ userId, roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.players[0].id !== userId) return socket.emit('error','Only host can start');
    if (room.players.length < 2) return socket.emit('error','Need at least 2 players');
    startGame(room);
  });

  socket.on('play_cards', ({ userId, roomId, cards }) => {
    handlePlay(socket, userId, roomId, cards);
  });

  socket.on('pass', ({ userId, roomId }) => {
    handlePass(socket, userId, roomId);
  });

  socket.on('bomb', ({ userId, roomId, cards }) => {
    handleBomb(socket, userId, roomId, cards);
  });

  socket.on('declare_auto_win', ({ userId, roomId }) => {
    handleAutoWin(socket, userId, roomId);
  });

  // ── Chat ────────────────────────────────────────────────────
  socket.on('chat', ({ userId, roomId, message }) => {
    const user = users[userId];
    const room = rooms[roomId];
    if (!user || !room) return;
    if (!message || !message.trim()) return;
    const msg = {
      username: user.username,
      text: message.trim().slice(0, 200),
      ts: Date.now()
    };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();
    io.to(roomId).emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    const userId = sockets[socket.id];
    if (userId) {
      delete sockets[socket.id];
      Object.values(rooms).forEach(room => {
        const p = room.players.find(p => p.id === userId);
        if (p) { p.connected = false; p.socketId = null; }
      });
    }
  });
});

// ── Game Actions ──────────────────────────────────────────────
function startGame(room) {
  const hands = G.dealCards();
  const startIdx = G.findStartingPlayer(hands);

  room.phase = 'PLAYING';
  room.game = {
    hands: {},
    finishOrder: [],
    currentPlayerIdx: startIdx,
    currentCombo: null,
    lastPlayerIdx: null,
    passCount: 0,
    firstTurn: true,
    bombWindow: false,
    bombCombo: null,
    bombPlayerId: null,
    doubleWin: {},
    bombEvents: [],
    roundNumber: 1,
  };

  room.players.forEach((p, i) => {
    room.game.hands[p.id] = hands[i];
    room.game.doubleWin[p.id] = { eligible: true, beaten: false };
    p.finished = false;
  });

  // Check auto-wins
  let autoWinners = [];
  room.players.forEach((p, i) => {
    const aw = G.checkAutoWin(hands[i]);
    if (aw) autoWinners.push({ player: p, type: aw });
  });

  if (autoWinners.length > 0) {
    const winner = autoWinners[0];
    emitGameState(room, null);
    io.to(room.id).emit('auto_win', {
      playerId: winner.player.id,
      username: winner.player.username,
      type: winner.type,
      hand: room.game.hands[winner.player.id].map(G.cardName)
    });
    setTimeout(() => resetRoom(room), 5000);
    return;
  }

  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      sock.emit('game_started', {
        hand: room.game.hands[p.id],
        gameState: buildGameState(room, p.id)
      });
    }
  });
  io.to(room.id).emit('room_updated', publicRoom(room));
}

function handlePlay(socket, userId, roomId, cards) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const g = room.game;
  const playerIdx = room.players.findIndex(p => p.id === userId);
  if (playerIdx !== g.currentPlayerIdx) return socket.emit('play_error','Not your turn');

  const hand = g.hands[userId];
  for (const c of cards) {
    if (!hand.includes(c)) return socket.emit('play_error','Card not in hand');
  }

  const combo = G.detectCombo(cards);
  if (combo.type === 'INVALID') return socket.emit('play_error','Invalid combination');

  // COMUNIS validation
  if (room.variant === 'COMUNIS') {
    const err = G.comunisValidationError(combo, G.sortCards(cards));
    if (err) return socket.emit('play_error', err);
  }

  if (g.firstTurn && !G.mustInclude3C(cards))
    return socket.emit('play_error','First play must include 3♣');

  if (g.currentCombo) {
    const doesBeat = room.variant === 'COMUNIS'
      ? G.beatsComunis(combo, g.currentCombo)
      : G.beats(combo, g.currentCombo);
    if (!doesBeat) return socket.emit('play_error','Does not beat current play');
  }

  // Track double win: mark whoever had the table as "beaten"
  if (g.currentCombo && g.lastPlayerIdx !== null && g.lastPlayerIdx !== playerIdx) {
    const beatenId = room.players[g.lastPlayerIdx].id;
    if (g.doubleWin[beatenId]) g.doubleWin[beatenId].beaten = true;
  }

  g.hands[userId] = G.removeCards(hand, cards);
  g.currentCombo = combo;
  g.lastPlayerIdx = playerIdx;
  g.passCount = 0;
  g.firstTurn = false;
  g.bombWindow = false;

  // Bomb window: pair of 2s played
  if (combo.type === 'PAIR' && combo.cards.every(c => G.cardRank(c) === 12)) {
    g.bombWindow = true;
    g.bombCombo = combo;
    g.bombPlayerId = userId;
    io.to(roomId).emit('bomb_window', { playerId: userId });
  }

  if (g.hands[userId].length === 0) {
    finishPlayer(room, userId, playerIdx);
    return;
  }

  advanceTurn(room, playerIdx);
  emitGameState(room, null);
}

function handlePass(socket, userId, roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const g = room.game;
  const playerIdx = room.players.findIndex(p => p.id === userId);
  if (playerIdx !== g.currentPlayerIdx) return socket.emit('play_error','Not your turn');
  if (!g.currentCombo) return socket.emit('play_error','Cannot pass on empty table');

  g.passCount++;
  const activePlayers = room.players.filter(p => !p.finished).length;

  if (g.passCount >= activePlayers - 1) {
    // Everyone passed — clear table, last player leads
    const lastLeader = room.players[g.lastPlayerIdx];
    g.currentCombo = null;
    g.passCount = 0;
    g.bombWindow = false;
    g.currentPlayerIdx = g.lastPlayerIdx;
    g.lastPlayerIdx = null;
    io.to(roomId).emit('table_cleared', { leaderId: lastLeader?.id });
  } else {
    advanceTurn(room, playerIdx);
  }
  emitGameState(room, null);
}

function handleBomb(socket, userId, roomId, cards) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const g = room.game;
  if (!g.bombWindow) return socket.emit('play_error','No bomb opportunity');

  const hand = g.hands[userId];
  for (const c of cards) {
    if (!hand.includes(c)) return socket.emit('play_error','Card not in hand');
  }

  const bombType = G.getBombType(cards, g.bombCombo);
  if (!bombType) return socket.emit('play_error','Not a valid bomb');

  const penalty = G.getBombPenalty(g.bombCombo, bombType, room.stakes);
  const bomberCombo = G.detectCombo(cards);

  g.bombEvents.push({ from: g.bombPlayerId, to: userId, amount: penalty });
  g.hands[userId] = G.removeCards(hand, cards);
  g.currentCombo = bomberCombo;
  g.lastPlayerIdx = room.players.findIndex(p => p.id === userId);
  g.passCount = 0;
  g.bombWindow = false;

  if (g.doubleWin[g.bombPlayerId]) g.doubleWin[g.bombPlayerId].beaten = true;

  io.to(roomId).emit('bombed', {
    bomberId: userId,
    victimId: g.bombPlayerId,
    bombType, penalty, cards
  });

  if (g.hands[userId].length === 0) {
    finishPlayer(room, userId, g.lastPlayerIdx);
    return;
  }

  advanceTurn(room, g.lastPlayerIdx);
  emitGameState(room, null);
}

function handleAutoWin(socket, userId, roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const hand = room.game.hands[userId];
  const aw = G.checkAutoWin(hand);
  if (!aw) return socket.emit('play_error','No auto-win in hand');

  io.to(roomId).emit('auto_win', {
    playerId: userId,
    username: room.players.find(p=>p.id===userId)?.username,
    type: aw,
    hand: hand.map(G.cardName)
  });
  setTimeout(() => resetRoom(room), 5000);
}

// ── Turn & Finish Logic ───────────────────────────────────────
function advanceTurn(room, fromIdx) {
  const players = room.players;
  let next = (fromIdx + 1) % players.length;
  let tries = 0;
  while (players[next].finished && tries++ < players.length) {
    next = (next + 1) % players.length;
  }
  room.game.currentPlayerIdx = next;
}

function finishPlayer(room, userId, playerIdx) {
  const g = room.game;
  room.players[playerIdx].finished = true;
  g.finishOrder.push(userId);

  const active = room.players.filter(p => !p.finished);
  if (active.length <= 1) {
    if (active.length === 1) {
      g.finishOrder.push(active[0].id);
      active[0].finished = true;
    }
    endGame(room);
    return;
  }

  io.to(room.id).emit('player_finished', {
    playerId: userId,
    position: g.finishOrder.length,
    username: room.players[playerIdx].username
  });
  advanceTurn(room, playerIdx);
  emitGameState(room, null);
}

function endGame(room) {
  const g = room.game;
  room.phase = 'FINISHED';

  const winner = g.finishOrder[0];
  const isDouble = g.doubleWin[winner] && !g.doubleWin[winner].beaten;

  const loser = g.finishOrder[3] || g.finishOrder[g.finishOrder.length-1];
  const loserHand = g.hands[loser] || [];
  const unplayedPenalty = loser ? G.getUnplayedPenalties(loserHand, room.stakes) : 0;

  // Handle < 4 players: pad finishOrder
  while (g.finishOrder.length < 4) g.finishOrder.push(null);

  const payouts = G.calcPayouts(
    g.finishOrder, isDouble, g.bombEvents, unplayedPenalty, room.stakes
  );

  g.finishOrder.forEach(pid => {
    if (!pid || !users[pid]) return;
    users[pid].coins += payouts[pid] || 0;
    if (pid === winner) users[pid].wins++;
    if (pid === loser) users[pid].losses++;
  });

  const results = g.finishOrder
    .filter(Boolean)
    .map((pid, i) => ({
      playerId: pid,
      username: room.players.find(p=>p.id===pid)?.username || '?',
      position: i+1,
      delta: payouts[pid] || 0,
      coins: users[pid]?.coins || 0,
      isDouble: i===0 && isDouble
    }));

  io.to(room.id).emit('game_over', { results, bombEvents: g.bombEvents, unplayedPenalty, isDouble });
  setTimeout(() => resetRoom(room), 10000);
}

function resetRoom(room) {
  room.phase = 'WAITING';
  room.game = null;
  room.players.forEach(p => p.finished = false);
  io.to(room.id).emit('room_updated', publicRoom(room));
  io.emit('room_list', getRoomList());
}

// ── State Helpers ─────────────────────────────────────────────
function buildGameState(room, forPlayerId) {
  const g = room.game;
  return {
    roomId: room.id,
    phase: room.phase,
    variant: room.variant,
    stakes: room.stakes,
    currentPlayerId: room.players[g.currentPlayerIdx]?.id,
    currentCombo: g.currentCombo ? {
      type: g.currentCombo.type,
      cards: g.currentCombo.cards.map(G.cardName),
      rawCards: g.currentCombo.cards,
      pairCount: g.currentCombo.pairCount,
      length: g.currentCombo.length
    } : null,
    bombWindow: g.bombWindow,
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      cardCount: g.hands[p.id]?.length || 0,
      finished: p.finished,
      coins: users[p.id]?.coins || 0
    })),
    myHand: forPlayerId ? (g.hands[forPlayerId] || []) : undefined,
    finishOrder: g.finishOrder
  };
}

function emitGameState(room, _) {
  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('game_state', buildGameState(room, p.id));
  });
}

// ── Utility ───────────────────────────────────────────────────
function makePlayer(user, socketId) {
  return {
    id: user.id, username: user.username, coins: user.coins,
    socketId, finished: false, ready: false, connected: true
  };
}

function leaveRoom(socket, userId, roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.players = room.players.filter(p => p.id !== userId);
  socket.leave(roomId);
  if (room.players.length === 0) {
    delete rooms[roomId];
  } else {
    io.to(roomId).emit('room_updated', publicRoom(room));
  }
  io.emit('room_list', getRoomList());
}

function leaveAllRooms(socket, userId) {
  Object.values(rooms).forEach(room => {
    if (room.players.find(p => p.id === userId))
      leaveRoom(socket, userId, room.id);
  });
}

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 Khmer Card Game running at http://localhost:${PORT}`);
});
