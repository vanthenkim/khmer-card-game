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

// ââ In-Memory Stores ââââââââââââââââââââââââââââââââââââââââââ
const users = {};   // userId -> { id, username, coins, diamonds, wins, losses }
const rooms = {};   // roomId -> RoomState
const sockets = {}; // socketId -> userId

// ââ Bot Names âââââââââââââââââââââââââââââââââââââââââââââââââ
const BOT_NAMES = ['ð¤ Bot Dara', 'ð¤ Bot Sokha', 'ð¤ Bot Mony'];
let botNameIdx = 0;

// ââ Auth ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Room Helpers ââââââââââââââââââââââââââââââââââââââââââââââ
function publicRoom(r) {
  return {
    id: r.id,
    name: r.name,
    stakes: r.stakes,
    variant: r.variant,
    playerCount: r.players.length,
    maxPlayers: 4,
    phase: r.phase,
    players: r.players.map(p => ({ id:p.id, username:p.username, coins:p.coins, ready:p.ready, isBot:!!p.isBot }))
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

  // ââ Add/Remove Bot ââââââââââââââââââââââââââââââââââââââââââ
  socket.on('add_bot', ({ userId, roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.players[0]?.id !== userId) return socket.emit('error', 'Only host can add bots');
    if (room.players.length >= 4) return socket.emit('error', 'Room full');
    if (room.phase !== 'WAITING') return socket.emit('error', 'Game already started');

    const botId = 'bot_' + uuid().slice(0, 6);
    const botName = BOT_NAMES[botNameIdx % BOT_NAMES.length];
    botNameIdx++;

    users[botId] = { id: botId, username: botName, coins: 1000, diamonds: 0, wins: 0, losses: 0, isBot: true };
    const botPlayer = {
      id: botId, username: botName, coins: 1000,
      socketId: null, finished: false, ready: true, connected: true, isBot: true
    };
    room.players.push(botPlayer);

    io.to(roomId).emit('room_updated', publicRoom(room));
    io.emit('room_list', getRoomList());
  });

  socket.on('remove_bot', ({ userId, roomId, botId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.players[0]?.id !== userId) return;
    const botPlayer = room.players.find(p => p.id === botId && p.isBot);
    if (!botPlayer) return;
    room.players = room.players.filter(p => p.id !== botId);
    delete users[botId];
    io.to(roomId).emit('room_updated', publicRoom(room));
    io.emit('room_list', getRoomList());
  });

  // ââ Chat ââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Game Actions ââââââââââââââââââââââââââââââââââââââââââââââ
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

  // Trigger bot turn if first player is a bot
  scheduleBotTurn(room);
}

// ââ Core Play/Pass Logic (shared by human and bot) ââââââââââââ
function doPlay(room, userId, playerIdx, cards) {
  const g = room.game;
  const hand = g.hands[userId];

  for (const c of cards) {
    if (!hand.includes(c)) return 'Card not in hand';
  }

  const combo = G.detectCombo(cards);
  if (combo.type === 'INVALID') return 'Invalid combination';

  if (room.variant === 'COMUNIS') {
    const err = G.comunisValidationError(combo, G.sortCards(cards));
    if (err) return err;
  }

  if (g.firstTurn && !G.mustInclude3C(cards))
    return 'First play must include 3â£';

  if (g.currentCombo) {
    const doesBeat = room.variant === 'COMUNIS'
      ? G.beatsComunis(combo, g.currentCombo)
      : G.beats(combo, g.currentCombo);
    if (!doesBeat) return 'Does not beat current play';
  }

  // Track double win
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
    io.to(room.id).emit('bomb_window', { playerId: userId });
  }

  if (g.hands[userId].length === 0) {
    finishPlayer(room, userId, playerIdx);
    return null;
  }

  advanceTurn(room, playerIdx);
  emitGameState(room, null);
  scheduleBotTurn(room);
  return null;
}

function doPass(room, userId, playerIdx) {
  const g = room.game;
  g.passCount++;
  const activePlayers = room.players.filter(p => !p.finished).length;

  if (g.passCount >= activePlayers - 1) {
    const lastLeader = room.players[g.lastPlayerIdx];
    g.currentCombo = null;
    g.passCount = 0;
    g.bombWindow = false;
    g.currentPlayerIdx = g.lastPlayerIdx;
    g.lastPlayerIdx = null;
    io.to(room.id).emit('table_cleared', { leaderId: lastLeader?.id });
  } else {
    advanceTurn(room, playerIdx);
  }
  emitGameState(room, null);
  scheduleBotTurn(room);
}

function handlePlay(socket, userId, roomId, cards) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const g = room.game;
  const playerIdx = room.players.findIndex(p => p.id === userId);
  if (playerIdx !== g.currentPlayerIdx) return socket.emit('play_error', 'Not your turn');
  const err = doPlay(room, userId, playerIdx, cards);
  if (err) socket.emit('play_error', err);
}

function handlePass(socket, userId, roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const g = room.game;
  const playerIdx = room.players.findIndex(p => p.id === userId);
  if (playerIdx !== g.currentPlayerIdx) return socket.emit('play_error', 'Not your turn');
  if (!g.currentCombo) return socket.emit('play_error', 'Cannot pass on empty table');
  doPass(room, userId, playerIdx);
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
  scheduleBotTurn(room);
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

// ââ Bot AI ââââââââââââââââââââââââââââââââââââââââââââââââââââ
function isBotTurn(room) {
  if (!room.game || room.phase !== 'PLAYING') return false;
  const p = room.players[room.game.currentPlayerIdx];
  return !!(p && p.isBot);
}

function scheduleBotTurn(room) {
  if (!isBotTurn(room)) return;
  const delay = 900 + Math.random() * 700; // 0.9â1.6s think time
  const roomId = room.id;
  setTimeout(() => executeBotTurn(roomId), delay);
}

function executeBotTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'PLAYING') return;
  const g = room.game;
  const playerIdx = g.currentPlayerIdx;
  const player = room.players[playerIdx];
  if (!player || !player.isBot) return;

  const hand = g.hands[player.id];
  if (!hand || hand.length === 0) return;

  const cards = botDecide(hand, g.currentCombo, room.variant, g.firstTurn);

  if (cards) {
    const err = doPlay(room, player.id, playerIdx, cards);
    if (err) {
      // Fallback: if doPlay failed, try to pass or play lowest single
      if (g.currentCombo) {
        doPass(room, player.id, playerIdx);
      } else {
        const sorted = G.sortCards([...hand]);
        doPlay(room, player.id, playerIdx, [sorted[0]]);
      }
    }
  } else if (g.currentCombo) {
    doPass(room, player.id, playerIdx);
  } else {
    // Leading and no card chosen â play lowest (shouldn't happen)
    const sorted = G.sortCards([...hand]);
    doPlay(room, player.id, playerIdx, [sorted[0]]);
  }
}

function botDecide(hand, currentCombo, variant, isFirstTurn) {
  const sorted = G.sortCards([...hand]);

  // First turn: must include 3â£ (card value = 0)
  if (isFirstTurn) {
    return [0]; // 3â£
  }

  // Leading (no current combo): play lowest single card
  if (!currentCombo) {
    return [sorted[0]];
  }

  const type = currentCombo.type;

  if (type === 'SINGLE') {
    for (const c of sorted) {
      const combo = G.detectCombo([c]);
      const ok = variant === 'COMUNIS'
        ? G.beatsComunis(combo, currentCombo)
        : G.beats(combo, currentCombo);
      if (ok) return [c];
    }
    return null;
  }

  if (type === 'PAIR') {
    const pairs = findPairsInHand(sorted, variant);
    for (const pair of pairs) {
      const combo = G.detectCombo(pair);
      if (combo.type === 'INVALID') continue;
      if (variant === 'COMUNIS') {
        const err = G.comunisValidationError(combo, G.sortCards(pair));
        if (err) continue;
        if (G.beatsComunis(combo, currentCombo)) return pair;
      } else {
        if (G.beats(combo, currentCombo)) return pair;
      }
    }
    return null;
  }

  if (type === 'TRIPLE') {
    const triples = findNOfAKindInHand(sorted, 3);
    for (const triple of triples) {
      const combo = G.detectCombo(triple);
      if (combo.type === 'INVALID') continue;
      if (G.beats(combo, currentCombo)) return triple;
    }
    return null;
  }

  if (type === 'QUAD') {
    const quads = findNOfAKindInHand(sorted, 4);
    for (const quad of quads) {
      const combo = G.detectCombo(quad);
      if (combo.type === 'INVALID') continue;
      if (G.beats(combo, currentCombo)) return quad;
    }
    return null;
  }

  // For complex combos (straights, full house, multi-pair): pass
  return null;
}

function findPairsInHand(sorted, variant) {
  const pairs = [];
  if (variant === 'COMUNIS') {
    // COMUNIS: pair = same color (red or black)
    const reds = sorted.filter(c => G.isRed(c));
    const blacks = sorted.filter(c => G.isBlack(c));
    for (let i = 0; i + 1 < reds.length; i++) pairs.push([reds[i], reds[i + 1]]);
    for (let i = 0; i + 1 < blacks.length; i++) pairs.push([blacks[i], blacks[i + 1]]);
  } else {
    // FREE: pair = same rank
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (G.cardRank(sorted[i]) === G.cardRank(sorted[i + 1])) {
        pairs.push([sorted[i], sorted[i + 1]]);
      }
    }
  }
  return pairs;
}

function findNOfAKindInHand(sorted, n) {
  const groups = [];
  for (let i = 0; i <= sorted.length - n; i++) {
    const group = sorted.slice(i, i + n);
    if (group.every(c => G.cardRank(c) === G.cardRank(group[0]))) {
      groups.push(group);
    }
  }
  return groups;
}

// ââ Turn & Finish Logic âââââââââââââââââââââââââââââââââââââââ
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
  scheduleBotTurn(room);
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
    if (!pid || !users[pid] || users[pid].isBot) return;
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
      delta: users[pid]?.isBot ? 0 : (payouts[pid] || 0),
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

// ââ State Helpers âââââââââââââââââââââââââââââââââââââââââââââ
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
      coins: users[p.id]?.coins || 0,
      isBot: !!p.isBot
    })),
    myHand: forPlayerId ? (g.hands[forPlayerId] || []) : undefined,
    finishOrder: g.finishOrder
  };
}

function emitGameState(room, _) {
  room.players.forEach(p => {
    if (p.isBot) return; // bots don't have sockets
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('game_state', buildGameState(room, p.id));
  });
}

// ââ Utility âââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Start Server ââââââââââââââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ð Khmer Card Game running at http://localhost:${PORT}`);
});
