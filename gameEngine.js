// ============================================================
// Khmer Card Game Engine - FREE (សេរី) Variant
// ============================================================

// Card encoding: value = gameRank * 4 + suit
// gameRank: 3=0, 4=1, 5=2, 6=3, 7=4, 8=5, 9=6, 10=7, J=8, Q=9, K=10, A=11, 2=12
// suit: C=0, S=1, D=2, H=3

const GAME_RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS = ['C','S','D','H'];
const SUIT_SYMBOLS = ['♣','♠','♦','♥'];
const SUIT_NAMES = ['Clubs','Spades','Diamonds','Hearts'];

// Face-value rank for multi-pair consecutive check: 2,3,4,...,K,A
// faceRank: 2=0, 3=1, 4=2, 5=3, 6=4, 7=5, 8=6, 9=7, 10=8, J=9, Q=10, K=11, A=12
const GAME_RANK_TO_FACE = { 0:1,1:2,2:3,3:4,4:5,5:6,6:7,7:8,8:9,9:10,10:11,11:12,12:0 };

function cardVal(rank, suit) { return rank * 4 + suit; }
function cardRank(v) { return Math.floor(v / 4); }
function cardSuit(v) { return v % 4; }
function cardFaceRank(v) { return GAME_RANK_TO_FACE[cardRank(v)]; }
function isRed(v) { return cardSuit(v) >= 2; }
function isBlack(v) { return cardSuit(v) < 2; }
function cardName(v) { return GAME_RANKS[cardRank(v)] + SUIT_SYMBOLS[cardSuit(v)]; }

function sortCards(cards) { return [...cards].sort((a,b) => a - b); }

// ── Deck ──────────────────────────────────────────────────────
function createDeck() {
  const d = [];
  for (let r = 0; r < 13; r++)
    for (let s = 0; s < 4; s++)
      d.push(cardVal(r, s));
  return d;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function dealCards() {
  const deck = shuffle(createDeck());
  return [0,1,2,3].map(i => sortCards(deck.slice(i*13, i*13+13)));
}

function findStartingPlayer(hands) {
  // 3♣ = cardVal(0,0) = 0
  for (let i = 0; i < hands.length; i++)
    if (hands[i].includes(0)) return i;
  return 0;
}

// ── Auto-Win Check ────────────────────────────────────────────
function checkAutoWin(hand) {
  if (hand.every(c => isRed(c))) return 'ALL_RED';
  if (hand.every(c => isBlack(c))) return 'ALL_BLACK';
  if (hand.filter(c => cardRank(c) === 12).length === 4) return 'FOUR_TWOS';
  return null;
}

// ── Combination Types ─────────────────────────────────────────
const CT = {
  SINGLE:'SINGLE', PAIR:'PAIR', TRIPLE:'TRIPLE', QUAD:'QUAD',
  FULL_HOUSE:'FULL_HOUSE', MULTI_PAIR:'MULTI_PAIR',
  STRAIGHT:'STRAIGHT', SUITED_STRAIGHT:'SUITED_STRAIGHT', INVALID:'INVALID'
};

function detectCombo(cards) {
  if (!cards || cards.length === 0) return { type: CT.INVALID };
  const s = sortCards(cards);
  const n = s.length;
  const ranks = s.map(cardRank);
  const suits = s.map(cardSuit);

  if (n === 1) return { type: CT.SINGLE, value: s[0], cards: s };

  if (n === 2) {
    if (ranks[0] === ranks[1]) return { type: CT.PAIR, value: s[1], cards: s };
    return { type: CT.INVALID };
  }

  if (n === 3) {
    if (ranks[0] === ranks[1] && ranks[1] === ranks[2])
      return { type: CT.TRIPLE, value: s[2], cards: s };
    return _straight(s);
  }

  if (n === 4) {
    if (ranks.every(r => r === ranks[0]))
      return { type: CT.QUAD, value: s[3], rank: ranks[0], cards: s };
    const mp = _multiPair(s);
    if (mp.type !== CT.INVALID) return mp;
    return _straight(s);
  }

  if (n === 5) {
    // Full house
    const rc = {};
    ranks.forEach(r => rc[r] = (rc[r]||0)+1);
    const cv = Object.values(rc).sort((a,b)=>a-b);
    if (cv.length === 2 && cv[0] === 2 && cv[1] === 3) {
      const tr = parseInt(Object.keys(rc).find(r => rc[r] === 3));
      const tcards = s.filter(c => cardRank(c) === tr);
      return { type: CT.FULL_HOUSE, value: tcards[2], tripleRank: tr, cards: s };
    }
    const mp = _multiPair(s); // unlikely for 5 cards but check
    if (mp.type !== CT.INVALID) return mp;
    return _straight(s);
  }

  // 6+ cards
  if (n % 2 === 0) {
    const mp = _multiPair(s);
    if (mp.type !== CT.INVALID) return mp;
  }
  return _straight(s);
}

function _multiPair(sorted) {
  const n = sorted.length;
  if (n % 2 !== 0 || n < 4) return { type: CT.INVALID };

  const groups = {};
  sorted.forEach(c => {
    const r = cardRank(c);
    if (!groups[r]) groups[r] = [];
    groups[r].push(c);
  });

  const uniqueRanks = Object.keys(groups).map(Number).sort((a,b)=>a-b);
  if (uniqueRanks.length !== n/2) return { type: CT.INVALID };
  if (!uniqueRanks.every(r => groups[r].length === 2)) return { type: CT.INVALID };

  // Check consecutive by face rank
  const faceRanks = uniqueRanks.map(r => GAME_RANK_TO_FACE[r]).sort((a,b)=>a-b);
  for (let i = 1; i < faceRanks.length; i++)
    if (faceRanks[i] !== faceRanks[i-1]+1) return { type: CT.INVALID };

  // Value = highest card in highest face-rank pair (by game rank = card value)
  const topRank = uniqueRanks.reduce((a,b) => GAME_RANK_TO_FACE[a] > GAME_RANK_TO_FACE[b] ? a : b);
  const topValue = Math.max(...groups[topRank]);

  return { type: CT.MULTI_PAIR, pairCount: uniqueRanks.length, value: topValue, cards: sorted };
}

function _straight(sorted) {
  const n = sorted.length;
  if (n < 3) return { type: CT.INVALID };

  const ranks = sorted.map(cardRank);
  const suits = sorted.map(cardSuit);

  // No 2s in straights
  if (ranks.includes(12)) return { type: CT.INVALID };

  // Consecutive, no duplicates
  const ur = [...new Set(ranks)].sort((a,b)=>a-b);
  if (ur.length !== n) return { type: CT.INVALID };
  for (let i = 1; i < ur.length; i++)
    if (ur[i] !== ur[i-1]+1) return { type: CT.INVALID };

  const topCard = sorted[n-1]; // highest value card
  const allSame = suits.every(s => s === suits[0]);

  if (allSame)
    return { type: CT.SUITED_STRAIGHT, length: n, value: topCard, suit: suits[0], cards: sorted };
  return { type: CT.STRAIGHT, length: n, value: topCard, cards: sorted };
}

// ── Comparison ────────────────────────────────────────────────
function beats(newCombo, current) {
  if (!current || current.type === CT.INVALID) return false;
  if (!newCombo || newCombo.type === CT.INVALID) return false;

  // Suited straight 5+ beats QUAD
  if (newCombo.type === CT.SUITED_STRAIGHT && newCombo.length >= 5 && current.type === CT.QUAD)
    return true;

  if (newCombo.type !== current.type) return false;

  switch (newCombo.type) {
    case CT.SINGLE:
    case CT.PAIR:
    case CT.TRIPLE:
    case CT.QUAD:
    case CT.FULL_HOUSE:
      return newCombo.value > current.value;
    case CT.MULTI_PAIR:
      return newCombo.pairCount === current.pairCount && newCombo.value > current.value;
    case CT.STRAIGHT:
      return newCombo.length === current.length && newCombo.value > current.value;
    case CT.SUITED_STRAIGHT:
      if (newCombo.length >= 5 && current.length >= 5)
        return newCombo.value > current.value;
      return newCombo.length === current.length && newCombo.value > current.value;
    default: return false;
  }
}

// ── Out-of-Turn Bomb Check ────────────────────────────────────
// Returns bomb type string or null
function getBombType(bombCards, currentCombo) {
  if (!currentCombo) return null;

  // Must be bombing a pair of 2s
  if (currentCombo.type === CT.PAIR) {
    const cr = currentCombo.cards.map(cardRank);
    if (!cr.every(r => r === 12)) return null; // not pair of 2s

    const bc = detectCombo(bombCards);

    // QUAD bombs pair of 2s
    if (bc.type === CT.QUAD) return 'QUAD';

    // Suited straight 5+ bombs pair of 2s
    if (bc.type === CT.SUITED_STRAIGHT && bc.length >= 5) return 'SUITED_STRAIGHT_5';

    // 4 consecutive pairs including 2s
    if (bc.type === CT.MULTI_PAIR && bc.pairCount === 4) {
      const ranks = bc.cards.map(cardRank);
      if (ranks.includes(12)) return 'FOUR_CONSEC_PAIRS'; // includes pair of 2s
    }
  }
  return null;
}

// ── Bomb Penalty Calculator ────────────────────────────────────
// Returns penalty amount the bomber collects from the person who played pair of 2s
function getBombPenalty(comboPlayed, bombType, stakes) {
  const unit = stakes.coins;
  if (bombType === 'FOUR_CONSEC_PAIRS') {
    // Penalty based on color of pair of 2s
    const cards = comboPlayed.cards;
    const allRed = cards.every(c => isRed(c));
    const allBlack = cards.every(c => isBlack(c));
    if (allRed) return unit * 4;
    if (allBlack) return unit * 2;
    return unit * 3; // mixed
  }
  // QUAD or SUITED_STRAIGHT_5 bombing pair of 2s
  const cards = comboPlayed.cards;
  const allRed = cards.every(c => isRed(c));
  return allRed ? unit * 2 : unit * 1;
}

// Penalty for 4th place holding unplayed power cards
function getUnplayedPenalties(hand, stakes) {
  const unit = stakes.coins;
  let penalty = 0;

  const ranks = hand.map(cardRank);
  const twos = hand.filter(c => cardRank(c) === 12);

  // Unplayed 2 red → 2 units, 2 black → 1 unit
  for (const two of twos) {
    penalty += isRed(two) ? unit * 2 : unit * 1;
  }

  // Unplayed Four of a Kind or Suited Straight (check for quad)
  const rc = {};
  ranks.forEach(r => rc[r] = (rc[r]||0)+1);
  const hasQuad = Object.values(rc).includes(4);
  if (hasQuad) penalty += unit * 2;

  // Check suited straight 5+
  for (let len = 13; len >= 5; len--) {
    if (_hasSuitedStraight(hand, len)) { penalty += unit * 2; break; }
  }

  return penalty;
}

function _hasSuitedStraight(hand, minLen) {
  const bySuit = [0,1,2,3].map(s => hand.filter(c => cardSuit(c) === s).map(cardRank).filter(r=>r!==12).sort((a,b)=>a-b));
  for (const suitCards of bySuit) {
    if (suitCards.length < minLen) continue;
    let run = 1, maxRun = 1;
    for (let i = 1; i < suitCards.length; i++) {
      run = suitCards[i] === suitCards[i-1]+1 ? run+1 : 1;
      maxRun = Math.max(maxRun, run);
    }
    if (maxRun >= minLen) return true;
  }
  return false;
}

// ── Final Scoring ─────────────────────────────────────────────
function calcPayouts(finishOrder, isDouble, bombEvents, unplayedPenalty4th, stakes) {
  // finishOrder: array of playerIds [1st, 2nd, 3rd, 4th]
  const unit = stakes.coins;
  const mult = isDouble ? 2 : 1;
  const delta = {};
  finishOrder.forEach(id => delta[id] = 0);

  delta[finishOrder[0]] += unit * 2 * mult;
  delta[finishOrder[1]] += unit * 1 * mult;
  delta[finishOrder[2]] -= unit * 1 * mult;
  delta[finishOrder[3]] -= unit * 2 * mult;

  // Bomb events: { from, to, amount }
  for (const ev of bombEvents) {
    delta[ev.from] -= ev.amount;
    delta[ev.to]   += ev.amount;
  }

  // 4th place unplayed penalty → goes to 3rd
  if (unplayedPenalty4th > 0) {
    delta[finishOrder[3]] -= unplayedPenalty4th;
    delta[finishOrder[2]] += unplayedPenalty4th;
  }

  return delta;
}

// ── COMUNIS (កុម្មុយនិស្ត) Validation ────────────────────────────
// Returns null if valid, or error string if invalid in COMUNIS mode
function comunisValidationError(combo, cards) {
  if (combo.type === CT.INVALID) return 'Invalid combination';
  if (combo.type === CT.PAIR) {
    // Both cards must be same color
    if (isRed(cards[0]) !== isRed(cards[1]))
      return 'COMUNIS: Pairs must be same color (red+red or black+black)';
  }
  if (combo.type === CT.MULTI_PAIR) {
    // All pairs must be same color
    const sorted = sortCards(cards);
    const groups = {};
    sorted.forEach(c => { const r=cardRank(c); if(!groups[r])groups[r]=[]; groups[r].push(c); });
    const firstColor = isRed(sorted[0]);
    if (!sorted.every(c => isRed(c) === firstColor))
      return 'COMUNIS: All pairs must be same color';
  }
  if (combo.type === CT.STRAIGHT) {
    // Mixed straights not allowed in COMUNIS
    return 'COMUNIS: Straights must be same suit';
  }
  return null; // valid
}

// ── COMUNIS Comparison ────────────────────────────────────────
function beatsComunis(newCombo, current) {
  if (!current || current.type === CT.INVALID) return false;
  if (!newCombo || newCombo.type === CT.INVALID) return false;

  // Suited straight 5+ beats QUAD (same as FREE)
  if (newCombo.type === CT.SUITED_STRAIGHT && newCombo.length >= 5 && current.type === CT.QUAD)
    return true;

  if (newCombo.type !== current.type) return false;

  switch (newCombo.type) {
    case CT.SINGLE: {
      const nr = cardRank(newCombo.value), cr = cardRank(current.value);
      const ns = cardSuit(newCombo.value), cs = cardSuit(current.value);
      // Any 2 beats any Ace (cross-suit exception)
      if (nr === 12 && cr === 11) return true;
      // 2 vs 2: suit order decides
      if (nr === 12 && cr === 12) return ns > cs;
      // All other: must be same suit, higher value
      return ns === cs && newCombo.value > current.value;
    }
    case CT.PAIR:
      // Same color required (top card color matches)
      if (isRed(newCombo.value) !== isRed(current.value)) return false;
      return newCombo.value > current.value;
    case CT.TRIPLE:
    case CT.QUAD:
    case CT.FULL_HOUSE:
      return newCombo.value > current.value;
    case CT.MULTI_PAIR:
      if (newCombo.pairCount !== current.pairCount) return false;
      // Color must match
      if (isRed(newCombo.value) !== isRed(current.value)) return false;
      return newCombo.value > current.value;
    case CT.SUITED_STRAIGHT:
      if (newCombo.length !== current.length) return false;
      return newCombo.value > current.value;
    case CT.STRAIGHT:
      return false; // doesn't exist in COMUNIS
    default: return false;
  }
}

// ── Double Win Check ──────────────────────────────────────────
// Tracked externally in game state.

// ── First Play Validation ─────────────────────────────────────
function mustInclude3C(cards) { return cards.includes(0); } // 0 = 3♣

// ── Remove cards from hand ────────────────────────────────────
function removeCards(hand, cards) {
  const h = [...hand];
  for (const c of cards) {
    const idx = h.indexOf(c);
    if (idx !== -1) h.splice(idx, 1);
  }
  return h;
}

module.exports = {
  CT, GAME_RANKS, SUITS, SUIT_SYMBOLS, SUIT_NAMES,
  cardVal, cardRank, cardSuit, cardName, isRed, isBlack, sortCards, cardFaceRank,
  createDeck, shuffle, dealCards, findStartingPlayer,
  checkAutoWin, detectCombo, beats, beatsComunis, comunisValidationError,
  getBombType, getBombPenalty, getUnplayedPenalties,
  calcPayouts, mustInclude3C, removeCards
};
