# Khmer Card Game — Project Context for Claude

## What this is
A multiplayer Khmer card game (big-two family) playable online with friends.
Built by Vanthen Kim (non-developer) with Claude's help.

## Live deployment
- **URL:** https://khmer-card-game-production.up.railway.app
- **Platform:** Railway — auto-deploys from GitHub `main` branch on every push
- **Repo:** https://github.com/vanthenkim/khmer-card-game

## Workflow for making changes
1. Edit files here in Cowork (Claude uses Read/Edit/Write tools directly)
2. Open **GitHub Desktop**, review the diff, commit, click **Push origin**
3. Railway auto-deploys in ~60 seconds — done

> Never use the GitHub web editor for this project. It requires painful base64 injection for large files.

## Tech stack
- **Server:** Node.js + Express + Socket.io (v4.6.1)
- **Client:** Single file — `public/index.html` (vanilla JS, no framework)
- **State:** In-memory only (no database — resets on server restart)
- **Entry point:** `server.js` → starts on `npm start`

## Key files
| File | Purpose |
|------|---------|
| `server.js` | Game server: rooms, game logic, bot AI, all socket events (~730 lines) |
| `public/index.html` | Full client app: all screens, UI, socket handlers (~1700 lines) |
| `package.json` | `"start": "node server.js"` · deps: express, socket.io, uuid |
| `railway.toml` | `startCommand = "node server.js"` |
| `gameEngine.js` | Standalone card logic helpers (imported by server.js) |

## Game rules summary

**Variants (selectable per room):**
- **FREE (សេរី):** pair = same rank
- **COMUNIS (កុម្មុយនិស្ត):** pair = same color (red/black)

**Card encoding:** `rank*4 + suit` · rank 3=0…2=12 · suits C=0,S=1,D=2,H=3
- Lowest: 3♣ = 0 · Highest single: 2♥ = 51
- First turn rule: player holding 3♣ (value 0) must include it

**Combo types:** SINGLE, PAIR, TRIPLE, QUAD, FULL_HOUSE, MULTI_PAIR, STRAIGHT, SUITED_STRAIGHT

**Bomb mechanic:** Playing pair-of-2s opens a bomb window → opponents can play 4-of-a-kind to bomb back

**Coins:** Players stake coins per game; deltas tracked in memory

## Bot player system (added 2026-06-11)
- Host clicks **"+ Add Bot 🤖"** in the waiting room to fill empty slots (up to 4 players total)
- Host can click **"×"** to remove a bot before the game starts
- Bot names: `🤖 Bot Dara`, `🤖 Bot Sokha`, `🤖 Bot Mony`
- Bot IDs: `'bot_' + uuid().slice(0, 6)` with `isBot: true` flag
- Bot AI runs server-side with 0.9–1.6s fake think delay
- Key functions in `server.js`: `isBotTurn()`, `scheduleBotTurn()`, `executeBotTurn()`
- Socket events: `add_bot`, `remove_bot`

## Features shipped
- [x] Core game engine (FREE variant)
- [x] COMUNIS variant
- [x] In-game chat
- [x] Sound effects + animations
- [x] EN/KH language toggle
- [x] Bot players (fill empty slots)

## Player / owner info
- Owner: Vanthen Kim · vanthen.kim@icf-cambodia.com · ICF Cambodia
- Wants concise responses — just do the work, skip the recap
