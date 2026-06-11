# ▶ How to Run the Khmer Card Game

## Requirements
- Node.js 16+ — download from https://nodejs.org

## First time setup
Open a terminal in this folder and run:
```
npm install
```

## Start the server
```
npm start
```

You'll see: `🃏 Khmer Card Game running at http://localhost:3000`

## Play
- **Same computer**: Open http://localhost:3000 in your browser
- **Local network** (phone/tablet on same WiFi): Open http://YOUR_PC_IP:3000
  - Find your IP: run `ipconfig` (Windows) → look for IPv4 Address
- **Online** (friends anywhere): Deploy to Railway or Render (free) — see below

## Deploy online (free)
1. Push this folder to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Set start command: `npm start`
4. Share the URL with friends!

## Game notes
- Accounts are in-memory — they reset when the server restarts
- Up to 4 players per room
- Both variants available: FREE (សេរី) and COMUNIS (កុម្មុយនិស្ត)
- Features: sound effects, animations, in-game chat, EN/KH language toggle
