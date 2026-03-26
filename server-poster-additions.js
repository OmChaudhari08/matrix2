// ══════════════════════════════════════════════════════════════════
// ADD TO server.js — Round 2.2 Poster/QR Cipher
// ══════════════════════════════════════════════════════════════════

// ── 1. Add to GAME_CONFIG ─────────────────────────────────────────
posterGroups: {
  1: { answer: 'ORACLE',         penalty: 60 },
  2: { answer: 'ZION',           penalty: 60 },
  3: { answer: 'NEBUCHADNEZZAR', penalty: 60 },
  4: { answer: 'MORPHEUS',       penalty: 60 },
},


// ── 2. Add to getOrCreateTeam() — new fields ──────────────────────
group: 0,           // TODO: set at registration (1–4)
round2bPhase: 'locked',  // locked | puzzle | done


// ── 3. Add to /api/my-state response ─────────────────────────────
round2bPhase: team.round2bPhase || 'locked',


// ── 4. New route: POST /api/submit-poster ─────────────────────────
if (req.method === 'POST' && route === '/api/submit-poster') {
  const { teamName, posterGroup, answer } = data;
  const teams = loadTeams();
  const team = teams[teamName];
  if (!team) return res.end(JSON.stringify({ ok: false, error: 'Team not found' }));

  // Must have completed round 2.1 first
  if (team.round2Phase !== 'done')
    return res.end(JSON.stringify({ ok: false, error: 'Complete Round 2.1 first' }));

  // Already solved
  if (team.round2bPhase === 'done')
    return res.end(JSON.stringify({ ok: true, correct: true, alreadySolved: true }));

  // Penalty check
  if (isPenalized(team))
    return res.end(JSON.stringify({
      ok: false, penalized: true,
      remaining: Math.ceil((team.penaltyUntil - Date.now()) / 1000)
    }));

  // Validate poster group matches team group
  const pg = parseInt(posterGroup);
  if (team.group && team.group !== pg)
    return res.end(JSON.stringify({ ok: false, error: 'Wrong group poster' }));

  const groupConfig = GAME_CONFIG.posterGroups[pg];
  if (!groupConfig)
    return res.end(JSON.stringify({ ok: false, error: 'Invalid group' }));

  team.round2bPhase = 'puzzle';
  const correct = answer.trim().toUpperCase() === groupConfig.answer.toUpperCase();

  if (correct) {
    team.round2bPhase = 'done';
    team.layer = 3;
    saveTeams(teams);
    return res.end(JSON.stringify({ ok: true, correct: true }));
  } else {
    team.totalStrikes++;
    team.penaltyUntil = Date.now() + groupConfig.penalty * 1000;
    saveTeams(teams);
    return res.end(JSON.stringify({
      ok: true, correct: false,
      penaltySeconds: groupConfig.penalty
    }));
  }
}


// ── 5. Add static routes for all 4 poster pages ──────────────────
// In the routes object inside the HTTP server handler:
'/poster/1': 'poster.html',
'/poster/2': 'poster.html',
'/poster/3': 'poster.html',
'/poster/4': 'poster.html',


// ── 6. Add group assignment to /api/register ──────────────────────
// When a team registers, set their group.
// You pre-assign groups before the event.
// Simplest approach — hardcode a lookup table:

const GROUP_ASSIGNMENTS = {
  // Fill this before event day
  // 'TEAM ALPHA': 1,
  // 'TEAM BETA':  2,
  // etc.
};

// Then inside /api/register, after getOrCreateTeam():
if (GROUP_ASSIGNMENTS[team.name]) {
  team.group = GROUP_ASSIGNMENTS[team.name];
  saveTeams(teams);
}

// Also expose group in register response so client can store it:
// Add to the return JSON: group: team.group || 0

// Client side — in poster.html init, after register:
// localStorage.setItem('matrixGroup', r.team.group);
