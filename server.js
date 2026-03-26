const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DATA_FILE = path.join(__dirname, 'data', 'teams.json');
const PORT = 3000;

// ══════════════════════════════════════════════════════════════════
// PUZZLE CONTENT — UPDATE EVERYTHING MARKED TODO BEFORE EVENT DAY
// ══════════════════════════════════════════════════════════════════

const GAME_CONFIG = {
  audioFile: '/audio/clue.mp3',      // TODO: place audio at public/audio/clue.mp3
  audioAnswer: 'TRINITY',           // TODO: actual answer from audio clue
  wordleWord: 'SMITH',
  labInstruction: 'Proceed immediately. Tell no one your path.',
  audioPenalty: 30,   // seconds
  round2Answer: 'DNIM RUOY EERF',
  round2Penalty: 60,
  round2Digit: '7',
  posterGroups: {
    1: { answer: 'ORACLE', penalty: 60 },
    2: { answer: 'ZION', penalty: 60 },
    3: { answer: 'NEBUCHADNEZZAR', penalty: 60 },
    4: { answer: 'MORPHEUS', penalty: 60 },
  },
  hints: {
    round1Audio: [
      { delaySeconds: 5 * 60, text: '<3' },
      { delaySeconds: 3 * 60, text: 'TODO: add the second Round 1 hint.' },
      { delaySeconds: 2 * 60, text: 'TODO: add the third Round 1 hint.' },
    ],
  },
};

// ══════════════════════════════════════════════════════════════════
// SEAT ASSIGNMENTS — map TEAM NAME (uppercase) → { lab, pc, group }
// group: 'A' | 'B' | 'C' | 'D'
//   A + B → Phase 1 (QR Poster) first, then Phase 2 (Red/Blue Pill)
//   C + D → Phase 2 (Red/Blue Pill) first, then Phase 1 (QR Poster)
// Fill this in before the event. Team names must match exactly
// what participants type at registration (stored as uppercase).
// ══════════════════════════════════════════════════════════════════
const SEAT_ASSIGNMENTS = {
  'TEAM ALPHA': { lab: 'LAB 1', pc: 'PC 01', group: 'A' },
  'TEAM BETA':  { lab: 'LAB 1', pc: 'PC 02', group: 'B' },
  'TEAM GAMMA': { lab: 'LAB 2', pc: 'PC 03', group: 'C' },
  'TEAM DELTA': { lab: 'LAB 2', pc: 'PC 04', group: 'D' },
  // TODO: add all teams before event day
};

const SEAT_FALLBACK = { lab: 'LAB ??', pc: 'PC ??', group: 'A' };

function getSeat(teamName) {
  return SEAT_ASSIGNMENTS[teamName] || SEAT_FALLBACK;
}

// A/B → poster first then pill | C/D → pill first then poster
function getRound2Order(teamName) {
  const g = getSeat(teamName).group || 'A';
  return (g === 'A' || g === 'B') ? 'poster-first' : 'pill-first';
}

function getLabReveal(teamName) {
  const seat = getSeat(teamName);
  return {
    lab: seat.lab,
    pc: seat.pc,
    instruction: GAME_CONFIG.labInstruction,
  };
}

const GROUP_ASSIGNMENTS = {};

// ── SSE clients ───────────────────────────────────────────────────────────────
let sseClients = [];

function broadcastSSE(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try { client.write(payload); return true; }
    catch { return false; }
  });
}

// ── Game state ────────────────────────────────────────────────────────────────
let gameState = { phase: 'waiting' };

// ── Data helpers ──────────────────────────────────────────────────────────────
function loadTeams() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveTeams(teams) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(teams, null, 2));
}

function getOrCreateTeam(teamName, teams) {
  if (!teams[teamName]) {
    teams[teamName] = {
      name: teamName,
      group: 0,
      round1Phase: 'waiting',  // waiting | audio | wordle | done
      round1AudioStartedAt: null,
      round2Phase: 'locked',   // locked | articles | answer | done
      round2bPhase: 'locked',  // locked | puzzle | done
      round2Attempts: 0,
      audioSolvedAt: null,
      wordleGuesses: [],
      wordleSolved: false,
      penaltyUntil: null,
      totalStrikes: 0,
      hints: 0,
      startTime: Date.now(),
      finished: false,
      finishTime: null,
      layer: 1,
    };
    saveTeams(teams);
  }
  const team = teams[teamName];
  let changed = false;

  const normalizedGroup = Number.parseInt(team.group, 10);
  if (!Number.isInteger(normalizedGroup) || normalizedGroup < 0) {
    if (team.group !== 0) {
      team.group = 0;
      changed = true;
    }
  } else if (team.group !== normalizedGroup) {
    team.group = normalizedGroup;
    changed = true;
  }

  if (!team.round2bPhase) {
    team.round2bPhase = 'locked';
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(team, 'round1AudioStartedAt')) {
    team.round1AudioStartedAt = null;
    changed = true;
  }

  if (changed) saveTeams(teams);
  return team;
}

function isPenalized(team) {
  return team.penaltyUntil && Date.now() < team.penaltyUntil;
}

function ensureRound1AudioStarted(team) {
  if (team.round1AudioStartedAt) return false;
  team.round1AudioStartedAt = Date.now();
  return true;
}

function getRound1AudioHintState(team) {
  const hintConfig = Array.isArray(GAME_CONFIG.hints && GAME_CONFIG.hints.round1Audio)
    ? GAME_CONFIG.hints.round1Audio
    : [];

  let unlockAfterSeconds = 0;
  const hintSteps = hintConfig
    .map((step, index) => {
      const delaySeconds = Math.max(0, Number.parseInt(step.delaySeconds, 10) || 0);
      const text = String(step.text || '').trim();
      unlockAfterSeconds += delaySeconds;
      if (!text) return null;
      return { number: index + 1, text, unlockAfterSeconds };
    })
    .filter(Boolean);

  if (!hintSteps.length) return null;

  if (team.round1Phase !== 'audio' || !team.round1AudioStartedAt) {
    return {
      totalHints: hintSteps.length,
      unlockedHints: [],
      pendingHints: hintSteps.map(hint => ({
        number: hint.number,
        text: hint.text,
        remainingSeconds: hint.unlockAfterSeconds,
      })),
    };
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - team.round1AudioStartedAt) / 1000));
  const unlockedHints = [];
  const pendingHints = [];

  hintSteps.forEach(hint => {
    if (elapsedSeconds >= hint.unlockAfterSeconds) {
      unlockedHints.push({ number: hint.number, text: hint.text });
    } else {
      pendingHints.push({
        number: hint.number,
        text: hint.text,
        remainingSeconds: hint.unlockAfterSeconds - elapsedSeconds,
      });
    }
  });

  return {
    totalHints: hintSteps.length,
    unlockedHints,
    pendingHints,
  };
}

// ── Wordle scorer ─────────────────────────────────────────────────────────────
function scoreWordle(guess, target) {
  const g = guess.toUpperCase().split('');
  const t = target.toUpperCase().split('');
  const result = Array(5).fill('absent');
  const tLeft = [...t];

  for (let i = 0; i < 5; i++) {
    if (g[i] === t[i]) { result[i] = 'correct'; tLeft[i] = null; }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'correct') continue;
    const idx = tLeft.indexOf(g[i]);
    if (idx !== -1) { result[i] = 'present'; tLeft[idx] = null; }
  }
  return g.map((letter, i) => ({ letter, result: result[i] }));
}

// ── API ───────────────────────────────────────────────────────────────────────
function handleAPI(req, res, parsedUrl) {
  const route = parsedUrl.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // SSE stream
  if (req.method === 'GET' && route === '/api/events') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);
    res.write(`event: phase\ndata: ${JSON.stringify({ phase: gameState.phase })}\n\n`);
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch {}

    // GET /api/teams
    if (req.method === 'GET' && route === '/api/teams') {
      const teams = loadTeams();
      const list = Object.values(teams).map(t => ({
        name: t.name,
        layer: t.layer,
        round1Phase: t.round1Phase,
        round2Phase: t.round2Phase || 'locked',
        finished: t.finished,
        totalStrikes: t.totalStrikes,
        hints: t.hints || 0,
        elapsed: t.finished ? t.finishTime - t.startTime : Date.now() - t.startTime,
      }));
      list.sort((a, b) => {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.layer !== b.layer) return b.layer - a.layer;
        return a.elapsed - b.elapsed;
      });
      return res.end(JSON.stringify({ ok: true, teams: list }));
    }

    // GET /api/my-state?team=NAME  (reconnect restore)
    if (req.method === 'GET' && route === '/api/my-state') {
      const teamName = parsedUrl.query.team;
      const teams = loadTeams();
      const team = teams[teamName] ? getOrCreateTeam(teamName, teams) : null;
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      if (team.round1Phase === 'audio' && ensureRound1AudioStarted(team)) saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true,
        teamName: team.name,
        group: team.group || 0,
        abcdGroup: getSeat(team.name).group || 'A',
        round2Order: getRound2Order(team.name),
        round1Phase: team.round1Phase,
        round1AudioHint: getRound1AudioHintState(team),
        round2Phase: team.round2Phase || 'locked',
        round2bPhase: team.round2bPhase || 'locked',
        round2Attempts: team.round2Attempts || 0,
        round2Digit: (team.round2Phase || 'locked') === 'done' ? GAME_CONFIG.round2Digit : null,
        wordleGuesses: team.wordleGuesses || [],
        penaltyRemaining: isPenalized(team) ? Math.ceil((team.penaltyUntil - Date.now()) / 1000) : 0,
        gamePhase: gameState.phase,
        reveal: team.round1Phase === 'done' ? getLabReveal(team.name) : null,
      }));
    }

    // POST /api/register
    if (req.method === 'POST' && route === '/api/register') {
      const { teamName } = data;
      if (!teamName || teamName.trim().length < 2)
        return res.end(JSON.stringify({ ok: false, error: 'Team name too short' }));
      const teams = loadTeams();
      const team = getOrCreateTeam(teamName.trim().toUpperCase(), teams);
      let changed = false;
      const assignedGroup = GROUP_ASSIGNMENTS[team.name];
      if (assignedGroup && team.group !== assignedGroup) {
        team.group = assignedGroup;
        changed = true;
      }
      if (gameState.phase === 'audio' && team.round1Phase === 'waiting') {
        team.round1Phase = 'audio';
        if (ensureRound1AudioStarted(team)) changed = true;
        changed = true;
      }
      if (team.round1Phase === 'audio' && ensureRound1AudioStarted(team)) changed = true;
      if (changed) saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true,
        team: { name: team.name, round1Phase: team.round1Phase, group: team.group || 0 },
        round1AudioHint: getRound1AudioHintState(team),
        gamePhase: gameState.phase,
      }));
    }

    // POST /api/admin/broadcast-audio
    if (req.method === 'POST' && route === '/api/admin/broadcast-audio') {
      gameState.phase = 'audio';
      const teams = loadTeams();
      Object.values(teams).forEach(t => {
        if (t.round1Phase === 'waiting') {
          t.round1Phase = 'audio';
          ensureRound1AudioStarted(t);
        }
      });
      saveTeams(teams);
      broadcastSSE('phase', { phase: 'audio', audioUrl: GAME_CONFIG.audioFile });
      console.log(' Audio broadcast triggered');
      return res.end(JSON.stringify({ ok: true, clientsNotified: sseClients.length }));
    }

    // POST /api/submit-audio
    if (req.method === 'POST' && route === '/api/submit-audio') {
      const { teamName, answer } = data;
      const teams = loadTeams();
      const team = teams[teamName];
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));
      if (isPenalized(team)) {
        return res.end(JSON.stringify({
          ok: false, penalized: true,
          remaining: Math.ceil((team.penaltyUntil - Date.now()) / 1000),
        }));
      }
      if (team.round1Phase === 'wordle' || team.round1Phase === 'done')
        return res.end(JSON.stringify({ ok: true, correct: true, alreadySolved: true }));

      const correct = answer.trim().toUpperCase() === GAME_CONFIG.audioAnswer.toUpperCase();
      if (correct) {
        team.round1Phase = 'wordle';
        team.audioSolvedAt = Date.now();
        saveTeams(teams);
        return res.end(JSON.stringify({ ok: true, correct: true }));
      } else {
        team.totalStrikes++;
        team.penaltyUntil = Date.now() + GAME_CONFIG.audioPenalty * 1000;
        saveTeams(teams);
        return res.end(JSON.stringify({
          ok: true, correct: false,
          penaltySeconds: GAME_CONFIG.audioPenalty,
        }));
      }
    }

    // POST /api/submit-wordle
    if (req.method === 'POST' && route === '/api/submit-wordle') {
      const { teamName, guess } = data;
      const teams = loadTeams();
      const team = teams[teamName];
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));
      if (team.round1Phase !== 'wordle')
        return res.end(JSON.stringify({ ok: false, error: 'Not in Wordle phase' }));

      const g = guess.trim().toUpperCase();
      if (g.length !== 5)
        return res.end(JSON.stringify({ ok: false, error: 'Guess must be 5 letters' }));

      const scored = scoreWordle(g, GAME_CONFIG.wordleWord);
      team.wordleGuesses = team.wordleGuesses || [];
      team.wordleGuesses.push({ guess: g, scored });

      const won = g === GAME_CONFIG.wordleWord.toUpperCase();
      const lost = !won && team.wordleGuesses.length >= 6;

      if (won) {
        team.round1Phase = 'done';
        team.wordleSolved = true;
        team.layer = 2;
        saveTeams(teams);
        return res.end(JSON.stringify({ ok: true, scored, won: true, reveal: getLabReveal(team.name) }));
      }
      if (lost) {
        team.wordleGuesses = [];
        team.totalStrikes++;
        team.penaltyUntil = Date.now() + 60 * 1000;
        saveTeams(teams);
        return res.end(JSON.stringify({
          ok: true, scored, won: false, lost: true,
          penaltySeconds: 60, message: 'All guesses used. 60s penalty. Board reset.',
        }));
      }
      saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true, scored, won: false,
        guessesLeft: 6 - team.wordleGuesses.length,
      }));
    }

    // POST /api/round2-enter
    if (req.method === 'POST' && route === '/api/round2-enter') {
      const { teamName } = data;
      const teams = loadTeams();
      const team = teams[teamName];
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));
      if (team.round1Phase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 1 first' }));

      if ((team.round2Phase || 'locked') === 'locked') {
        team.round2Phase = 'articles';
        saveTeams(teams);
      }

      return res.end(JSON.stringify({
        ok: true,
        round2Phase: team.round2Phase || 'locked',
        round2Attempts: team.round2Attempts || 0,
        round2Digit: (team.round2Phase || 'locked') === 'done' ? GAME_CONFIG.round2Digit : null,
        abcdGroup: getSeat(team.name).group || 'A',
        round2Order: getRound2Order(team.name),
      }));
    }

    // POST /api/submit-round2
    if (req.method === 'POST' && route === '/api/submit-round2') {
      const { teamName, answer } = data;
      const teams = loadTeams();
      const team = teams[teamName];
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));

      if (team.round1Phase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 1 first' }));

      if ((team.round2Phase || 'locked') === 'done') {
        return res.end(JSON.stringify({
          ok: true,
          correct: true,
          alreadySolved: true,
          digit: GAME_CONFIG.round2Digit,
          attemptsUsed: team.round2Attempts || 0,
        }));
      }

      if (isPenalized(team)) {
        return res.end(JSON.stringify({
          ok: false,
          penalized: true,
          remaining: Math.ceil((team.penaltyUntil - Date.now()) / 1000),
        }));
      }

      team.round2Phase = 'answer';
      team.round2Attempts = (team.round2Attempts || 0) + 1;

      const correct = String(answer || '').trim().toUpperCase() === GAME_CONFIG.round2Answer.toUpperCase();

      if (correct) {
        team.round2Phase = 'done';
        team.layer = 3;
        saveTeams(teams);
        return res.end(JSON.stringify({
          ok: true,
          correct: true,
          digit: GAME_CONFIG.round2Digit,
          attemptsUsed: team.round2Attempts,
        }));
      }

      team.totalStrikes++;
      team.penaltyUntil = Date.now() + GAME_CONFIG.round2Penalty * 1000;
      saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true,
        correct: false,
        penaltySeconds: GAME_CONFIG.round2Penalty,
        attemptsUsed: team.round2Attempts,
      }));
    }

    // POST /api/submit-poster
    if (req.method === 'POST' && route === '/api/submit-poster') {
      const { teamName, posterGroup, answer } = data;
      const teams = loadTeams();
      const team = teams[teamName] ? getOrCreateTeam(teamName, teams) : null;
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));

      if (team.round2Phase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 2.1 first' }));

      if (team.round2bPhase === 'done')
        return res.end(JSON.stringify({ ok: true, correct: true, alreadySolved: true }));

      if (isPenalized(team)) {
        return res.end(JSON.stringify({
          ok: false,
          penalized: true,
          remaining: Math.ceil((team.penaltyUntil - Date.now()) / 1000),
        }));
      }

      const pg = Number.parseInt(posterGroup, 10);
      const groupConfig = GAME_CONFIG.posterGroups[pg];
      if (!groupConfig)
        return res.end(JSON.stringify({ ok: false, error: 'Invalid group' }));

      if (team.group && team.group !== pg)
        return res.end(JSON.stringify({ ok: false, error: 'Wrong group poster' }));

      team.round2bPhase = 'puzzle';
      const normalizedAnswer = String(answer || '').trim().toUpperCase();
      const correct = normalizedAnswer === groupConfig.answer.toUpperCase();

      if (correct) {
        team.round2bPhase = 'done';
        team.layer = Math.max(team.layer || 1, 3);
        saveTeams(teams);
        return res.end(JSON.stringify({ ok: true, correct: true }));
      }

      team.totalStrikes++;
      team.penaltyUntil = Date.now() + groupConfig.penalty * 1000;
      saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true,
        correct: false,
        penaltySeconds: groupConfig.penalty,
      }));
    }

    res.end(JSON.stringify({ ok: false, error: 'Unknown route' }));
  });
}

// ── Static files ──────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg',
};

function serveStatic(req, res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[ext] || 'text/plain');
    res.writeHead(200); res.end(data);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/')) return handleAPI(req, res, parsedUrl);

  const routes = {
    '/': 'index.html', '/play': 'index.html',
    '/leaderboard': 'leaderboard.html', '/admin': 'admin.html',
    '/round2': 'round2.html',
    '/poster/1': 'poster.html',
    '/poster/2': 'poster.html',
    '/poster/3': 'poster.html',
    '/poster/4': 'poster.html',
  };
  const file = routes[pathname] || pathname.slice(1);
  serveStatic(req, res, path.join(__dirname, 'public', file));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n MATRIX ESCAPE SERVER ONLINE`);
  console.log(`   Player:   http://localhost:${PORT}`);
  console.log(`   Round 2:  http://localhost:${PORT}/round2`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Board:    http://localhost:${PORT}/leaderboard\n`);
});
