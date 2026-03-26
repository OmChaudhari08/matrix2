const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DATA_FILE = path.join(__dirname, 'data', 'teams.json');
const GAME_CONFIG_FILE = path.join(__dirname, 'data', 'game-config.json');
const ASSIGNMENTS_FILE = path.join(__dirname, 'data', 'assignments.json');
const WORDLE_WORDS_FILE = path.join(__dirname, 'data', 'wordle-words.json');
const PORT = 3000;

// ── Reset teams on startup (event-day fresh state) ────────────────────────────
try {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
} catch (err) {
  console.error('Failed to reset teams.json on startup:', err);
}

// ── Config + assignments ─────────────────────────────────────────────────────
const DEFAULT_GAME_CONFIG = {
  audioFile: '/audio/clue.mp3',
  audioAnswer: 'TRINITY',
  wordleWord: 'SMITH',
  labInstruction: 'Proceed immediately. Tell no one your path.',
  audioPenalty: 30,
  round2Answer: 'DNIM RUOY EERF',
  round2Penalty: 60,
  round2Digit: '7',
  posterGroups: {},
  hints: { round1Audio: [] },
};

const DEFAULT_ASSIGNMENTS = {
  teams: {},
  fallback: { flowGroup: 'A', posterGroup: 0 },
};

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function getGameConfig() {
  return readJsonSafe(GAME_CONFIG_FILE, DEFAULT_GAME_CONFIG);
}

function getAssignments() {
  return readJsonSafe(ASSIGNMENTS_FILE, DEFAULT_ASSIGNMENTS);
}

function getWordleWords() {
  const words = readJsonSafe(WORDLE_WORDS_FILE, []);
  return Array.isArray(words) ? words.filter(w => String(w || '').trim().length === 5) : [];
}

function hashTeamName(name) {
  const str = String(name || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function getTeamWordleIndex(team, teamName, words) {
  if (!words.length) return 0;
  if (Number.isInteger(team.wordleIndex) && team.wordleIndex >= 0) {
    return team.wordleIndex % words.length;
  }
  const idx = hashTeamName(teamName) % words.length;
  team.wordleIndex = idx;
  return idx;
}

function getTeamWordleWord(team, teamName, words, fallback) {
  if (!words.length) return String(fallback || '').toUpperCase();
  const idx = getTeamWordleIndex(team, teamName, words);
  return String(words[idx] || '').toUpperCase();
}

function normalizeFlowGroup(value, fallback) {
  const g = String(value || fallback || 'A').toUpperCase();
  return ['A', 'B', 'C', 'D'].includes(g) ? g : (fallback || 'A');
}

function normalizeRound2Order(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'poster-first' || v === 'poster') return 'poster-first';
  if (v === 'articles-first' || v === 'articles') return 'articles-first';
  return '';
}

function normalizePosterGroup(value) {
  const pg = Number.parseInt(value, 10);
  return Number.isInteger(pg) && pg > 0 ? pg : 0;
}

function getSeat(teamName, assignments) {
  const fallback = assignments.fallback || DEFAULT_ASSIGNMENTS.fallback;
  const team = (assignments.teams && assignments.teams[teamName]) || null;
  const round2Order = normalizeRound2Order(team && team.round2Order);
  return {
    flowGroup: normalizeFlowGroup(team && team.flowGroup, fallback.flowGroup),
    posterGroup: normalizePosterGroup(team && team.posterGroup),
    qrCode: team && team.qrCode ? String(team.qrCode) : '',
    round2Order,
  };
}

// A/B → poster first then articles | C/D → articles first then poster
function getRound2Order(teamName, assignments) {
  const seat = getSeat(teamName, assignments);
  if (seat.round2Order) return seat.round2Order;
  const g = seat.flowGroup || 'A';
  return (g === 'A' || g === 'B') ? 'poster-first' : 'articles-first';
}

function getLabReveal(teamName, assignments, gameConfig) {
  return {
    instruction: gameConfig.labInstruction || 'Proceed to the lab.',
  };
}

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
      flowGroup: 'A',
      posterGroup: 0,
      round1Phase: 'waiting',  // waiting | audio | wordle | done
      round1AudioStartedAt: null,
      round2ArticlesPhase: 'locked', // locked | articles | answer | done
      round2PosterPhase: 'locked',   // locked | puzzle | done
      round2Attempts: 0,
      audioSolvedAt: null,
      wordleGuesses: [],
      wordleSolved: false,
      wordleIndex: null,
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

  const normalizedPosterGroup = normalizePosterGroup(team.posterGroup);
  if (team.posterGroup !== normalizedPosterGroup) {
    team.posterGroup = normalizedPosterGroup;
    changed = true;
  }

  const normalizedFlow = normalizeFlowGroup(team.flowGroup, 'A');
  if (team.flowGroup !== normalizedFlow) {
    team.flowGroup = normalizedFlow;
    changed = true;
  }

  if (!team.round2ArticlesPhase && team.round2Phase) {
    team.round2ArticlesPhase = team.round2Phase;
    changed = true;
  }

  if (!team.round2PosterPhase && team.round2bPhase) {
    team.round2PosterPhase = team.round2bPhase;
    changed = true;
  }

  if (!team.round2ArticlesPhase) {
    team.round2ArticlesPhase = 'locked';
    changed = true;
  }

  if (!team.round2PosterPhase) {
    team.round2PosterPhase = 'locked';
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

function normalizeAnswer(input) {
  return String(input || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function ensureRound1AudioStarted(team) {
  if (team.round1AudioStartedAt) return false;
  team.round1AudioStartedAt = Date.now();
  return true;
}

function getRound1AudioHintState(team, gameConfig) {
  const hintConfig = Array.isArray(gameConfig.hints && gameConfig.hints.round1Audio)
    ? gameConfig.hints.round1Audio
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
    const gameConfig = getGameConfig();
    const assignments = getAssignments();
    const wordleWords = getWordleWords();
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch {}

    // GET /api/teams
    if (req.method === 'GET' && route === '/api/teams') {
      const teams = loadTeams();
      const list = Object.values(teams).map(t => ({
        name: t.name,
        layer: t.layer,
        round1Phase: t.round1Phase,
        round2ArticlesPhase: t.round2ArticlesPhase || 'locked',
        round2PosterPhase: t.round2PosterPhase || 'locked',
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
      if (team.wordleIndex == null && wordleWords.length) {
        team.wordleIndex = getTeamWordleIndex(team, team.name, wordleWords);
        saveTeams(teams);
      }
      return res.end(JSON.stringify({
        ok: true,
        teamName: team.name,
        flowGroup: getSeat(team.name, assignments).flowGroup || 'A',
        posterGroup: team.posterGroup || 0,
        round2Order: getRound2Order(team.name, assignments),
        round1Phase: team.round1Phase,
        round1AudioHint: getRound1AudioHintState(team, gameConfig),
        round2ArticlesPhase: team.round2ArticlesPhase || 'locked',
        round2PosterPhase: team.round2PosterPhase || 'locked',
        round2Attempts: team.round2Attempts || 0,
        round2Digit: (team.round2ArticlesPhase || 'locked') === 'done' ? gameConfig.round2Digit : null,
        wordleGuesses: team.wordleGuesses || [],
        penaltyRemaining: isPenalized(team) ? Math.ceil((team.penaltyUntil - Date.now()) / 1000) : 0,
        gamePhase: gameState.phase,
        reveal: team.round1Phase === 'done' ? getLabReveal(team.name, assignments, gameConfig) : null,
      }));
    }

    // GET /api/poster-config?group=1
    if (req.method === 'GET' && route === '/api/poster-config') {
      const pg = Number.parseInt(parsedUrl.query.group, 10);
      const groupConfig = gameConfig.posterGroups && gameConfig.posterGroups[String(pg)];
      if (!groupConfig) return res.end(JSON.stringify({ ok: false, error: 'Invalid group' }));
      return res.end(JSON.stringify({
        ok: true,
        group: {
          label: groupConfig.label || `GROUP ${pg}`,
          shift: groupConfig.shift || 0,
          message: groupConfig.message || '',
        },
      }));
    }

    // POST /api/register
    if (req.method === 'POST' && route === '/api/register') {
      const { teamName } = data;
      if (!teamName || teamName.trim().length < 2)
        return res.end(JSON.stringify({ ok: false, error: 'Team name too short' }));
      const teams = loadTeams();
      const normalizedName = teamName.trim().toUpperCase();
      if (!assignments.teams || !assignments.teams[normalizedName]) {
        return res.end(JSON.stringify({ ok: false, error: 'Team not registered' }));
      }
      const team = getOrCreateTeam(normalizedName, teams);
      let changed = false;
      if (team.wordleIndex == null && wordleWords.length) {
        team.wordleIndex = getTeamWordleIndex(team, team.name, wordleWords);
        changed = true;
      }
      const seat = getSeat(team.name, assignments);
      if (team.flowGroup !== seat.flowGroup) { team.flowGroup = seat.flowGroup; changed = true; }
      if (team.posterGroup !== seat.posterGroup) { team.posterGroup = seat.posterGroup; changed = true; }
      if (gameState.phase === 'audio' && team.round1Phase === 'waiting') {
        team.round1Phase = 'audio';
        if (ensureRound1AudioStarted(team)) changed = true;
        changed = true;
      }
      if (team.round1Phase === 'audio' && ensureRound1AudioStarted(team)) changed = true;
      if (changed) saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true,
        team: { name: team.name, round1Phase: team.round1Phase, flowGroup: team.flowGroup, posterGroup: team.posterGroup || 0 },
        round1AudioHint: getRound1AudioHintState(team, gameConfig),
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
      broadcastSSE('phase', { phase: 'audio', audioUrl: gameConfig.audioFile });
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

      const correct = normalizeAnswer(answer) === normalizeAnswer(gameConfig.audioAnswer);
      if (correct) {
        team.round1Phase = 'wordle';
        team.audioSolvedAt = Date.now();
        saveTeams(teams);
        return res.end(JSON.stringify({ ok: true, correct: true }));
      } else {
        team.totalStrikes++;
        team.penaltyUntil = Date.now() + gameConfig.audioPenalty * 1000;
        saveTeams(teams);
        return res.end(JSON.stringify({
          ok: true, correct: false,
          penaltySeconds: gameConfig.audioPenalty,
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

      const currentWord = getTeamWordleWord(team, team.name, wordleWords, gameConfig.wordleWord);
      const scored = scoreWordle(g, currentWord);
      team.wordleGuesses = team.wordleGuesses || [];
      team.wordleGuesses.push({ guess: g, scored });

      const won = g === currentWord;
      const lost = !won && team.wordleGuesses.length >= 6;

      if (won) {
        team.round1Phase = 'done';
        team.wordleSolved = true;
        team.layer = 2;
        saveTeams(teams);
        return res.end(JSON.stringify({ ok: true, scored, won: true, reveal: getLabReveal(team.name, assignments, gameConfig) }));
      }
      if (lost) {
        team.wordleGuesses = [];
        team.totalStrikes++;
        if (wordleWords.length) {
          const nextIndex = (getTeamWordleIndex(team, team.name, wordleWords) + 1) % wordleWords.length;
          team.wordleIndex = nextIndex;
        }
        saveTeams(teams);
        return res.end(JSON.stringify({
          ok: true, scored, won: false, lost: true,
          message: 'All guesses used. New word loaded. Board reset.',
        }));
      }
      saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true, scored, won: false,
        guessesLeft: 6 - team.wordleGuesses.length,
      }));
    }

    // POST /api/round2-enter (Round 2 Articles)
    if (req.method === 'POST' && route === '/api/round2-enter') {
      const { teamName } = data;
      const teams = loadTeams();
      const team = teams[teamName];
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));
      if (team.round1Phase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 1 first' }));

      if ((team.round2ArticlesPhase || 'locked') === 'locked') {
        team.round2ArticlesPhase = 'articles';
        saveTeams(teams);
      }

      return res.end(JSON.stringify({
        ok: true,
        round2ArticlesPhase: team.round2ArticlesPhase || 'locked',
        round2Attempts: team.round2Attempts || 0,
        round2Digit: (team.round2ArticlesPhase || 'locked') === 'done' ? gameConfig.round2Digit : null,
        flowGroup: getSeat(team.name, assignments).flowGroup || 'A',
        round2Order: getRound2Order(team.name, assignments),
      }));
    }

    // POST /api/submit-round2 (Round 2 Articles)
    if (req.method === 'POST' && route === '/api/submit-round2') {
      const { teamName, answer } = data;
      const teams = loadTeams();
      const team = teams[teamName];
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));

      if (team.round1Phase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 1 first' }));

      if ((team.round2ArticlesPhase || 'locked') === 'done') {
        return res.end(JSON.stringify({
          ok: true,
          correct: true,
          alreadySolved: true,
          digit: gameConfig.round2Digit,
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

      team.round2ArticlesPhase = 'answer';
      team.round2Attempts = (team.round2Attempts || 0) + 1;

      const correct = normalizeAnswer(answer) === normalizeAnswer(gameConfig.round2Answer);

      if (correct) {
        team.round2ArticlesPhase = 'done';
        team.layer = Math.max(team.layer || 1, 3);
        saveTeams(teams);
        return res.end(JSON.stringify({
          ok: true,
          correct: true,
          digit: gameConfig.round2Digit,
          attemptsUsed: team.round2Attempts,
        }));
      }

      team.totalStrikes++;
      team.penaltyUntil = Date.now() + gameConfig.round2Penalty * 1000;
      saveTeams(teams);
      return res.end(JSON.stringify({
        ok: true,
        correct: false,
        penaltySeconds: gameConfig.round2Penalty,
        attemptsUsed: team.round2Attempts,
      }));
    }

    // POST /api/submit-qr-code (Round 2 Poster access)
    if (req.method === 'POST' && route === '/api/submit-qr-code') {
      const { teamName, code } = data;
      const teams = loadTeams();
      const team = teams[teamName] ? getOrCreateTeam(teamName, teams) : null;
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));
      if (team.round1Phase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 1 first' }));
      if (isPenalized(team)) {
        return res.end(JSON.stringify({
          ok: false,
          penalized: true,
          remaining: Math.ceil((team.penaltyUntil - Date.now()) / 1000),
        }));
      }

      const seat = getSeat(team.name, assignments);
      const expected = String(seat.qrCode || '').trim().toUpperCase();
      const supplied = String(code || '').trim().toUpperCase();

      if (!expected) return res.end(JSON.stringify({ ok: false, error: 'No access code assigned' }));
      if (expected !== supplied) {
        team.totalStrikes++;
        team.penaltyUntil = Date.now() + 30 * 1000;
        saveTeams(teams);
        return res.end(JSON.stringify({ ok: false, error: 'Invalid code', penaltySeconds: 30 }));
      }

      return res.end(JSON.stringify({
        ok: true,
        posterGroup: seat.posterGroup || 0,
      }));
    }

    // POST /api/submit-poster (Round 2 Poster)
    if (req.method === 'POST' && route === '/api/submit-poster') {
      const { teamName, posterGroup, answer } = data;
      const teams = loadTeams();
      const team = teams[teamName] ? getOrCreateTeam(teamName, teams) : null;
      if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));

      const round2Order = getRound2Order(team.name, assignments);
      if (round2Order === 'articles-first' && team.round2ArticlesPhase !== 'done')
        return res.end(JSON.stringify({ ok: false, error: 'Complete Round 2 Articles first' }));

      if (team.round2PosterPhase === 'done')
        return res.end(JSON.stringify({ ok: true, correct: true, alreadySolved: true }));

      if (isPenalized(team)) {
        return res.end(JSON.stringify({
          ok: false,
          penalized: true,
          remaining: Math.ceil((team.penaltyUntil - Date.now()) / 1000),
        }));
      }

      const pg = Number.parseInt(posterGroup, 10);
      const groupConfig = gameConfig.posterGroups && gameConfig.posterGroups[String(pg)];
      if (!groupConfig)
        return res.end(JSON.stringify({ ok: false, error: 'Invalid group' }));

      if (team.posterGroup && team.posterGroup !== pg)
        return res.end(JSON.stringify({ ok: false, error: 'Wrong group poster' }));

      team.round2PosterPhase = 'puzzle';
      const normalizedAnswer = String(answer || '').trim().toUpperCase();
      const correct = normalizedAnswer === groupConfig.answer.toUpperCase();

      if (correct) {
        team.round2PosterPhase = 'done';
        team.layer = Math.max(team.layer || 1, 4);
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
    '/': 'round1/index.html', '/play': 'round1/index.html', '/round1': 'round1/index.html',
    '/leaderboard': 'leaderboard/index.html', '/admin': 'admin/index.html',
    '/round2': 'round2/articles.html', '/round2/articles': 'round2/articles.html',
    '/round2/poster/1': 'round2/poster.html',
    '/round2/poster/2': 'round2/poster.html',
    '/round2/poster/3': 'round2/poster.html',
    '/round2/poster/4': 'round2/poster.html',
    '/poster/1': 'round2/poster.html',
    '/poster/2': 'round2/poster.html',
    '/poster/3': 'round2/poster.html',
    '/poster/4': 'round2/poster.html',
  };
  const file = routes[pathname] || pathname.slice(1);
  serveStatic(req, res, path.join(__dirname, 'public', file));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n MATRIX ESCAPE SERVER ONLINE`);
  console.log(`   Player:   http://localhost:${PORT}`);
  console.log(`   Round 2:  http://localhost:${PORT}/round2/articles`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Board:    http://localhost:${PORT}/leaderboard\n`);
});
