"use strict";

// THE VAULT demo server. Uses only Node's built-in modules.
// Run from this folder with: node server.js

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomInt } = require("node:crypto");

const ROOT = __dirname;
const LEADERBOARD_FILE = path.join(ROOT, "leaderboard.json");
const PORT = Number(process.env.PORT) || 4173;
const ROLES = ["hacker", "muscle", "lookout"];
const QUICK_CHAT = Object.freeze({ clear: "CLEAR!", wait: "WAIT!", help: "HELP!" });
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();
const playersByToken = new Map();
let leaderboardWrite = Promise.resolve();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const LEVELS = [
  { number: 1, name: "THE ENTRY", guards: 1, duration: 240, patrolCycle: 16, patrolWindow: 4, puzzle: [3, 4] },
  { number: 2, name: "INNER VAULT", guards: 3, duration: 180, patrolCycle: 12, patrolWindow: 5, puzzle: [18, 27] },
  { number: 3, name: "THE CORE", guards: 5, duration: 150, patrolCycle: 10, patrolWindow: 6, changesCode: true },
];

let leaderboard = loadLeaderboard();

function cleanName(input) {
  const cleaned = String(input || "").replace(/[<>\u0000-\u001f\u007f]/g, "").trim().slice(0, 18);
  return cleaned || "Operator";
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate a room code.");
}

function currentLevel(room) {
  return LEVELS[room.level - 1] || LEVELS[LEVELS.length - 1];
}

function normalizeLeaderboard(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const names = Array.isArray(entry.names) ? entry.names.map(cleanName).filter(Boolean).slice(0, 3) : [];
    const timeTaken = Math.max(0, Math.floor(Number(entry.timeTaken) || 0));
    const completedAt = typeof entry.completedAt === "string" ? entry.completedAt : "";
    return { id: String(entry.id || randomUUID()), names, timeTaken, completedAt };
  }).filter((entry) => entry.names.length > 0 && entry.timeTaken > 0)
    .sort((left, right) => left.timeTaken - right.timeTaken || left.completedAt.localeCompare(right.completedAt))
    .slice(0, 5);
}

function loadLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
    return normalizeLeaderboard(parsed);
  } catch (_) {
    try { fs.writeFileSync(LEADERBOARD_FILE, "[]\n", "utf8"); } catch (error) { console.error("Could not initialize leaderboard.json:", error.message); }
    return [];
  }
}

function persistLeaderboard() {
  const snapshot = `${JSON.stringify(leaderboard, null, 2)}\n`;
  leaderboardWrite = leaderboardWrite.then(async () => {
    const temporary = `${LEADERBOARD_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, snapshot, "utf8");
    await fs.promises.rename(temporary, LEADERBOARD_FILE);
  }).catch((error) => {
    console.error("Could not save leaderboard:", error.message);
  });
  return leaderboardWrite;
}

function broadcastLeaderboard() {
  for (const room of rooms.values()) broadcast(room, "leaderboard-updated", { leaderboard });
}

function recordWinningCrew(room) {
  const names = [...room.players.values()].filter((player) => !player.isBot).map((player) => player.name);
  if (names.length === 0) return;
  const entry = { id: randomUUID(), names, timeTaken: room.stats.timeTaken, completedAt: new Date().toISOString() };
  leaderboard = normalizeLeaderboard([...leaderboard, entry]);
  void persistLeaderboard();
  broadcastLeaderboard();
}

function makePuzzle(level) {
  let left;
  let right;
  if (level.number === 1) {
    [left, right] = level.puzzle;
  } else if (level.number === 2) {
    [left, right] = level.puzzle;
  } else {
    left = randomInt(12, 48);
    right = randomInt(11, 42);
  }
  return { left, right, answer: left + right };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    role: player.role,
    isBot: player.isBot,
    connected: player.isBot || player.connected,
    isHost: !player.isBot && player.isHost,
  };
}

function serializeRoom(room, viewer) {
  const level = currentLevel(room);
  const disconnected = [...room.players.values()].filter((player) => !player.isBot && !player.connected);
  const reconnectDeadline = disconnected.length
    ? Math.min(...disconnected.map((player) => player.disconnectedAt + 30000))
    : null;

  return {
    roomId: room.id,
    state: room.state,
    mode: room.mode,
    hostId: room.hostId,
    players: [...room.players.values()].map(publicPlayer),
    you: viewer ? { id: viewer.id, role: viewer.role, isHost: viewer.isHost } : null,
    level: room.level,
    levelName: level.name,
    guards: level.guards,
    levelDuration: level.duration,
    timeRemaining: room.timeRemaining,
    elapsedSeconds: room.stats.timeTaken,
    levelElapsed: room.levelElapsed,
    phase: room.phase,
    guardNear: room.guardNear,
    patrolSecondsUntilClear: room.guardNear
      ? Math.max(0, level.patrolWindow - (room.levelElapsed % level.patrolCycle))
      : Math.max(0, level.patrolCycle - (room.levelElapsed % level.patrolCycle)),
    puzzleHint: room.puzzle ? `${room.puzzle.left} + ${room.puzzle.right} = ?` : null,
    codeChangesIn: room.codeChangesIn,
    disconnected: disconnected.map((player) => ({ name: player.name, role: player.role })),
    paused: room.state === "running" && disconnected.length > 0,
    pauseReason: room.pauseReason,
    reconnectSeconds: reconnectDeadline === null ? null : Math.max(0, Math.ceil((reconnectDeadline - Date.now()) / 1000)),
    stats: { ...room.stats },
    result: room.result,
    message: room.message,
    chat: room.chat.slice(-6),
    overloadCharges: Math.max(0, 3 - room.overloadUsedLevels.size),
    overloadAvailable: room.state === "running" && viewer?.role === "hacker" && !room.overloadUsedLevels.has(room.level),
    overloadActive: Date.now() < room.overloadUntil,
    overloadRemaining: Math.max(0, room.overloadUntil - Date.now()),
  };
}

function sendToPlayer(player, type, detail = {}) {
  if (!player.stream || player.stream.destroyed || player.stream.writableEnded) return;
  const payload = {
    type,
    playerId: player.id,
    connectionId: player.streamId,
    state: serializeRoom(player.room, player),
    ...detail,
  };
  try {
    player.stream.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (_) {
    // The response close handler will mark this player disconnected.
  }
}

function broadcast(room, type, detail = {}) {
  for (const player of room.players.values()) sendToPlayer(player, type, detail);
}

function createPlayer(room, name, role, options = {}) {
  const player = {
    id: randomUUID(),
    token: options.bot ? null : randomUUID(),
    room,
    name: cleanName(name),
    role,
    isBot: Boolean(options.bot),
    isHost: Boolean(options.host),
    connected: Boolean(options.bot),
    stream: null,
    streamId: null,
    disconnectedAt: null,
    lastSeenAt: null,
    graceTimer: null,
    actionTimes: [],
    lastChatAt: 0,
  };
  room.players.set(player.id, player);
  if (player.token) playersByToken.set(player.token, player);
  return player;
}

function occupiedRoles(room, excludeId) {
  return new Set([...room.players.values()].filter((player) => player.id !== excludeId).map((player) => player.role));
}

function firstFreeRole(room) {
  const occupied = occupiedRoles(room);
  return ROLES.find((role) => !occupied.has(role));
}

function initializeLevel(room, number) {
  room.level = number;
  const level = currentLevel(room);
  room.timeRemaining = level.duration;
  room.levelElapsed = 0;
  room.phase = "hacker";
  room.guardNear = false;
  room.spottedThisWindow = false;
  room.puzzle = makePuzzle(level);
  room.codeChangesIn = level.changesCode ? 30 : null;
  room.message = `${level.name} // ${level.guards} ${level.guards === 1 ? "GUARD" : "GUARDS"}`;
}

function roomHasDisconnectedPlayers(room) {
  return [...room.players.values()].some((player) => !player.isBot && !player.connected);
}

function stopGameTimers(room) {
  if (room.tickTimer) clearInterval(room.tickTimer);
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.overloadTimer) clearTimeout(room.overloadTimer);
  room.tickTimer = null;
  room.botTimer = null;
  room.overloadTimer = null;
}

function removePlayer(room, player, eventType = "player-left") {
  if (!player || room.players.get(player.id) !== player) return;
  if (player.graceTimer) clearTimeout(player.graceTimer);
  player.graceTimer = null;
  const oldStream = player.stream;
  player.stream = null;
  player.streamId = null;
  player.connected = false;
  player.lastSeenAt = null;
  if (oldStream && !oldStream.destroyed && !oldStream.writableEnded) oldStream.end();
  if (player.token) playersByToken.delete(player.token);
  room.players.delete(player.id);
  if (room.hostId === player.id) {
    const successor = [...room.players.values()].find((member) => !member.isBot);
    room.hostId = successor ? successor.id : null;
    if (successor) successor.isHost = true;
  }
  if (room.players.size === 0) rooms.delete(room.id);
  else broadcast(room, eventType, { actor: player.name });
}

function endGame(room, won, reason, extra = {}) {
  if (room.state !== "running") return;
  room.state = "ended";
  room.phase = "ended";
  room.result = {
    won,
    reason,
    detail: extra.detail || (won ? "All three vault levels cleared." : "The operation could not continue."),
    disconnectedName: extra.disconnectedName || null,
    levelReached: room.level,
  };
  if (won) recordWinningCrew(room);
  for (const player of room.players.values()) {
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = null;
  }
  stopGameTimers(room);
  room.message = won ? "HEIST COMPLETE" : "OPERATION FAILED";
  broadcast(room, "game-ended");
}

function maybeResume(room) {
  if (room.state !== "running" || roomHasDisconnectedPlayers(room)) return;
  room.paused = false;
  room.pauseReason = null;
  room.message = "CREW RECONNECTED // RESUME OPERATION";
  broadcast(room, "game-resumed");
  scheduleBotAction(room);
}

function disconnectPlayer(player, streamId, explicit = false) {
  if (!player || player.isBot || (streamId && player.streamId !== streamId)) return;
  if (!player.connected && !player.stream) return;
  if (player.streamId && (!streamId || player.streamId === streamId)) {
    const oldStream = player.stream;
    player.stream = null;
    player.streamId = null;
    if (explicit && oldStream && !oldStream.destroyed && !oldStream.writableEnded) oldStream.end();
  }
  player.connected = false;
  player.disconnectedAt = Date.now();
  player.lastSeenAt = null;
  const room = player.room;
  if (room.state === "running") {
    room.paused = true;
    room.pauseReason = `${player.name} has disconnected. Waiting for reconnection...`;
    if (!player.graceTimer) {
      player.graceTimer = setTimeout(() => {
        if (room.state === "running" && !player.connected) {
          endGame(room, false, "disconnect", {
            disconnectedName: player.name,
            detail: `${player.name} did not reconnect within 30 seconds.`,
          });
        }
      }, 30000);
      player.graceTimer.unref?.();
    }
  } else if (room.state === "lobby" && !player.graceTimer) {
    player.graceTimer = setTimeout(() => {
      if (room.state === "lobby" && !player.connected) removePlayer(room, player, "player-expired");
    }, 30000);
    player.graceTimer.unref?.();
  }
  if (room.state !== "ended") broadcast(room, explicit ? "player-disconnected" : "player-disconnected");
}

function attachEventStream(player, req, res) {
  const wasConnected = player.connected;
  const wasDisconnected = !wasConnected && player.disconnectedAt !== null;
  const previousStream = player.stream;
  const streamId = randomUUID();
  player.streamId = streamId;
  player.stream = res;
  player.connected = true;
  player.disconnectedAt = null;
  player.lastSeenAt = Date.now();
  if (player.graceTimer) clearTimeout(player.graceTimer);
  player.graceTimer = null;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": vault connected\n\n");
  const keepAlive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": keep-alive\n\n");
  }, 12000);
  keepAlive.unref?.();
  res.on("close", () => {
    clearInterval(keepAlive);
    disconnectPlayer(player, streamId);
  });
  req.on("aborted", () => disconnectPlayer(player, streamId));
  if (previousStream && previousStream !== res && !previousStream.destroyed) previousStream.end();
  if (wasDisconnected && player.room.state === "running") {
    if (roomHasDisconnectedPlayers(player.room)) broadcast(player.room, "player-reconnected");
    else maybeResume(player.room);
  }
  else broadcast(player.room, wasConnected ? "room-state" : "player-reconnected");
}

function countHumans(room) {
  return [...room.players.values()].filter((player) => !player.isBot).length;
}

function startGame(room, host) {
  if (room.state !== "lobby") throw httpError(409, "This room has already started.");
  if (!host.isHost) throw httpError(403, "Only the room host can start the heist.");
  const humans = [...room.players.values()].filter((player) => !player.isBot);
  if (humans.length < 1) throw httpError(409, "At least one operator is required.");
  if (humans.some((player) => !player.connected)) throw httpError(409, "Wait for disconnected operators to reconnect before starting.");
  if (humans.length < 3) {
    room.mode = humans.length === 1 ? "solo-ai" : "crew-ai";
    let botNumber = 1;
    while (room.players.size < 3) {
      const role = firstFreeRole(room);
      const botName = role === "hacker" ? "PATCH" : role === "muscle" ? "ANVIL" : "SENTRY";
      createPlayer(room, `${botName}${botNumber > 1 ? `-${botNumber}` : ""}`, role, { bot: true });
      botNumber += 1;
    }
  } else {
    room.mode = "CREW";
  }
  room.state = "running";
  room.startedAt = Date.now();
  room.stats = { timeTaken: 0, wrongButtons: 0, guardSightings: 0 };
  room.result = null;
  room.paused = false;
  room.pauseReason = null;
  initializeLevel(room, 1);
  room.tickTimer = setInterval(() => tickRoom(room), 1000);
  room.tickTimer.unref?.();
  room.message = "OPERATION LIVE // WATCH YOUR ROLE OBJECTIVE";
  broadcast(room, "game-started");
  scheduleBotAction(room);
}

function tickRoom(room) {
  if (room.state !== "running") return;
  if (roomHasDisconnectedPlayers(room)) {
    room.paused = true;
    broadcast(room, "game-paused");
    return;
  }
  room.paused = false;
  room.stats.timeTaken += 1;
  room.levelElapsed += 1;
  room.timeRemaining = Math.max(0, room.timeRemaining - 1);

  const level = currentLevel(room);
  const cyclePosition = room.levelElapsed % level.patrolCycle;
  const nextGuardNear = Date.now() >= room.guardSuppressedUntil && cyclePosition < level.patrolWindow;
  if (nextGuardNear !== room.guardNear) {
    room.guardNear = nextGuardNear;
    if (!room.guardNear) room.spottedThisWindow = false;
    broadcast(room, room.guardNear ? "guard-near" : "patrol-clear");
  }

  if (level.changesCode) {
    room.codeChangesIn -= 1;
    if (room.codeChangesIn <= 0) {
      room.puzzle = makePuzzle(level);
      room.codeChangesIn = 30;
      broadcast(room, "code-changed");
    }
  }
  if (room.timeRemaining <= 0) {
    endGame(room, false, "timeout", { detail: `The timer expired on ${level.name}.` });
    return;
  }
  broadcast(room, "timer");
  scheduleBotAction(room);
}

function registerWrongAction(room) {
  room.stats.wrongButtons += 1;
  if (room.guardNear && !room.spottedThisWindow) {
    room.stats.guardSightings += 1;
    room.spottedThisWindow = true;
  }
}

function handleGameAction(room, player, action, value, fromBot = false) {
  if (room.state !== "running" || roomHasDisconnectedPlayers(room)) return;
  if (!fromBot) {
    const now = Date.now();
    player.actionTimes = player.actionTimes.filter((time) => now - time < 1000);
    if (player.actionTimes.length >= 5) throw httpError(429, "Slow down and try again in a moment.");
    player.actionTimes.push(now);
  }

  if (action === "SYSTEM_OVERLOAD") {
    if (player.role !== "hacker" || room.overloadUsedLevels.has(room.level)) {
      registerWrongAction(room);
      room.message = player.role !== "hacker" ? "SYSTEM OVERLOAD // HACKER ACCESS ONLY" : "SYSTEM OVERLOAD // CHARGE ALREADY USED THIS LEVEL";
    } else {
      room.overloadUsedLevels.add(room.level);
      room.overloadUntil = Date.now() + 2600;
      room.guardSuppressedUntil = Math.max(room.guardSuppressedUntil, Date.now() + 5500);
      if (room.guardNear) {
        room.guardNear = false;
        room.spottedThisWindow = false;
        broadcast(room, "patrol-clear");
      }
      room.message = "SYSTEM OVERLOAD // CAMERAS SCRAMBLED, PATROL BLIND";
      if (room.overloadTimer) clearTimeout(room.overloadTimer);
      room.overloadTimer = setTimeout(() => {
        room.overloadTimer = null;
        if (room.state === "running") broadcast(room, "system-restored");
      }, 2600);
      room.overloadTimer.unref?.();
      broadcast(room, "system-overload", { activator: player.name, duration: 2600 });
    }
  } else if (action === "SUBMIT_CODE") {
    if (player.role !== "hacker" || room.phase !== "hacker") {
      registerWrongAction(room);
      room.message = "WRONG ACTION // WAIT FOR THE HACKER PHASE";
    } else if (Number(value) !== room.puzzle.answer || !/^\d{1,3}$/.test(String(value || ""))) {
      registerWrongAction(room);
      room.message = room.level === 3 ? "ACCESS DENIED // SIGNAL CHANGES IN 30 SECONDS" : "ACCESS DENIED // TRY THE SIGNAL AGAIN";
    } else {
      room.phase = "lookout";
      room.message = "LOCK DISABLED // LOOKOUT, CONFIRM THE ROUTE";
    }
  } else if (action === "CALL_CLEAR") {
    if (player.role !== "lookout" || room.phase !== "lookout" || room.guardNear) {
      registerWrongAction(room);
      room.message = room.guardNear ? "GUARD NEAR // DO NOT CALL CLEAR" : "WRONG ACTION // WAIT FOR THE LOOKOUT PHASE";
    } else {
      room.phase = "muscle";
      room.message = "ROUTE CLEAR // MUSCLE, BREACH ON SIGNAL";
    }
  } else if (action === "BREACH") {
    if (player.role !== "muscle" || room.phase !== "muscle" || room.guardNear) {
      registerWrongAction(room);
      room.message = room.guardNear ? "GUARD NEAR // HOLD POSITION" : "WAIT FOR THE LOOKOUT TO CALL CLEAR";
    } else if (room.level < 3) {
      const completedLevel = room.level;
      initializeLevel(room, room.level + 1);
      broadcast(room, "level-complete", { completedLevel });
      scheduleBotAction(room);
      return;
    } else {
      endGame(room, true, "success", { detail: "The crew cleared all three levels and escaped with the take." });
      return;
    }
  } else {
    throw httpError(400, "Unknown action.");
  }
  broadcast(room, "action-result", { actor: player.name, action });
  scheduleBotAction(room);
}

function scheduleBotAction(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.state !== "running" || roomHasDisconnectedPlayers(room)) return;
  const bot = [...room.players.values()].find((player) => player.isBot && player.role === roleForPhase(room.phase));
  if (!bot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.state !== "running" || roomHasDisconnectedPlayers(room)) return;
    if (room.phase === "hacker") {
      handleGameAction(room, bot, "SUBMIT_CODE", room.puzzle.answer, true);
    } else if (room.phase === "lookout" && !room.guardNear) {
      handleGameAction(room, bot, "CALL_CLEAR", null, true);
    } else if (room.phase === "muscle" && !room.guardNear) {
      handleGameAction(room, bot, "BREACH", null, true);
    }
  }, 700);
  room.botTimer.unref?.();
}

function roleForPhase(phase) {
  if (phase === "hacker") return "hacker";
  if (phase === "lookout") return "lookout";
  if (phase === "muscle") return "muscle";
  return null;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8192) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(httpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function findPlayer(token) {
  const player = playersByToken.get(String(token || ""));
  if (!player || !rooms.has(player.room.id) || player.room.players.get(player.id) !== player) {
    throw httpError(401, "Session not found. Create or join a room again.");
  }
  return player;
}

function attachRoomToken(res, player) {
  sendJson(res, 200, {
    ok: true,
    token: player.token,
    roomId: player.room.id,
    playerId: player.id,
    name: player.name,
    state: serializeRoom(player.room, player),
  });
}

function makeRoom() {
  const room = {
    id: makeRoomCode(),
    players: new Map(),
    hostId: null,
    state: "lobby",
    mode: "CREW",
    level: 1,
    phase: "lobby",
    timeRemaining: 0,
    levelElapsed: 0,
    guardNear: false,
    spottedThisWindow: false,
    puzzle: null,
    codeChangesIn: null,
    stats: { timeTaken: 0, wrongButtons: 0, guardSightings: 0 },
    result: null,
    chat: [],
    overloadUsedLevels: new Set(),
    overloadUntil: 0,
    guardSuppressedUntil: 0,
    overloadTimer: null,
    message: "WAITING FOR CREW",
    tickTimer: null,
    botTimer: null,
    paused: false,
    pauseReason: null,
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function assignRole(room, requestedRole) {
  const free = firstFreeRole(room);
  if (requestedRole && ROLES.includes(requestedRole)) {
    if (!occupiedRoles(room).has(requestedRole)) return requestedRole;
    throw httpError(409, "That role is already taken. Rotate roles or choose an open slot.");
  }
  if (!free) throw httpError(409, "This room already has a full crew.");
  return free;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "the-vault", rooms: rooms.size });
  }
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    return sendJson(res, 200, { ok: true, entries: leaderboard });
  }
  if (req.method === "GET" && url.pathname === "/api/session") {
    const player = findPlayer(url.searchParams.get("token"));
    return attachRoomToken(res, player);
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    const player = findPlayer(url.searchParams.get("token"));
    return attachEventStream(player, req, res);
  }
  if (req.method !== "POST") throw httpError(404, "Route not found.");

  const body = await readJson(req);
  if (url.pathname === "/api/rooms/create") {
    const room = makeRoom();
    const role = assignRole(room, body.role);
    const player = createPlayer(room, body.name, role, { host: true });
    room.hostId = player.id;
    broadcast(room, "room-created");
    return attachRoomToken(res, player);
  }

  if (url.pathname === "/api/rooms/join") {
    const roomId = String(body.roomId || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const room = rooms.get(roomId);
    if (!room) throw httpError(404, "Room not found. Check the code and try again.");
    if (room.state !== "lobby") throw httpError(409, "This heist has already started.");
    if (body.token) {
      const existing = playersByToken.get(String(body.token));
      if (existing) {
        if (existing.room.id !== room.id) throw httpError(409, "This saved session belongs to a different room. Leave it before joining another.");
        return attachRoomToken(res, existing);
      }
    }
    if (countHumans(room) >= 3) throw httpError(409, "This room is full.");
    const role = assignRole(room, body.role);
    const player = createPlayer(room, body.name, role, { host: room.hostId === null });
    if (!room.hostId) room.hostId = player.id;
    broadcast(room, "player-joined", { actor: player.name });
    return attachRoomToken(res, player);
  }

  if (url.pathname === "/api/rooms/leave") {
    const player = findPlayer(body.token);
    const room = player.room;
    if (room.state === "running") throw httpError(409, "Leaving during a live heist counts as a disconnect. Close the tab to reconnect within 30 seconds.");
    removePlayer(room, player, "player-left");
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/pulse") {
    const player = findPlayer(body.token);
    if (!player.connected || !player.streamId || String(body.connectionId || "") !== player.streamId) {
      throw httpError(409, "Room stream changed. Reconnecting now.");
    }
    player.lastSeenAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/disconnect") {
    const player = findPlayer(body.token);
    disconnectPlayer(player, String(body.connectionId || ""), true);
    return sendJson(res, 200, { ok: true });
  }

  const player = findPlayer(body.token);
  const room = player.room;
  if (url.pathname === "/api/rooms/role") {
    if (room.state !== "lobby") throw httpError(409, "Roles are locked after the heist starts.");
    const role = String(body.role || "").toLowerCase();
    if (!ROLES.includes(role)) throw httpError(400, "Choose Hacker, Muscle, or Lookout.");
    if (occupiedRoles(room, player.id).has(role)) throw httpError(409, "That role is already taken.");
    player.role = role;
    broadcast(room, "role-changed", { actor: player.name });
    return sendJson(res, 200, { ok: true, state: serializeRoom(room, player) });
  }

  if (url.pathname === "/api/rooms/rotate") {
    if (room.state !== "lobby") throw httpError(409, "Roles are locked after the heist starts.");
    if (!player.isHost) throw httpError(403, "Only the room host can rotate roles.");
    for (const member of room.players.values()) {
      if (!member.isBot) member.role = ROLES[(ROLES.indexOf(member.role) + 1) % ROLES.length];
    }
    room.message = "ROLE ROTATION COMPLETE";
    broadcast(room, "roles-rotated");
    return sendJson(res, 200, { ok: true, state: serializeRoom(room, player) });
  }

  if (url.pathname === "/api/rooms/start") {
    startGame(room, player);
    return sendJson(res, 200, { ok: true, state: serializeRoom(room, player) });
  }

  if (url.pathname === "/api/rooms/chat") {
    if (room.state !== "running") throw httpError(409, "Quick chat is available during a live heist.");
    if (!player.connected) throw httpError(409, "Reconnect before sending a callout.");
    const now = Date.now();
    if (now - player.lastChatAt < 650) throw httpError(429, "Wait a moment before sending another callout.");
    const text = QUICK_CHAT[String(body.message || "").toLowerCase()];
    if (!text) throw httpError(400, "Choose Clear, Wait, or Help.");
    player.lastChatAt = now;
    const chatMessage = { id: randomUUID(), name: player.name, role: player.role, text, sentAt: now };
    room.chat.push(chatMessage);
    room.chat = room.chat.slice(-12);
    broadcast(room, "quick-chat", { chatMessage });
    return sendJson(res, 200, { ok: true, state: serializeRoom(room, player) });
  }

  if (url.pathname === "/api/rooms/action") {
    if (room.state !== "running") throw httpError(409, "There is no active heist in this room.");
    if (!player.connected) throw httpError(409, "Reconnect before taking an action.");
    if (roomHasDisconnectedPlayers(room)) throw httpError(409, "The mission is paused until your crew reconnects.");
    if (player.isBot) throw httpError(403, "AI operators act automatically.");
    handleGameAction(room, player, String(body.action || ""), body.value);
    return sendJson(res, 200, { ok: true, state: serializeRoom(room, player) });
  }

  throw httpError(404, "Route not found.");
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") throw httpError(405, "Method not allowed.");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    throw httpError(400, "Invalid URL.");
  }
  const fileName = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!new Set(["index.html", "styles.css", "app.js"]).has(fileName)) throw httpError(404, "File not found.");
  const filePath = path.join(ROOT, fileName);
  let contents;
  try {
    contents = fs.readFileSync(filePath);
  } catch (_) {
    throw httpError(404, "File not found.");
  }
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath)],
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (req.method === "HEAD") res.end();
  else res.end(contents);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendJson(res, error.status || 500, { ok: false, error: error.message || "Internal server error." });
    if (!error.status) console.error(error);
  }
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const oldEnded = room.state === "ended" && now - room.createdAt > 6 * 60 * 60 * 1000;
    const abandonedLobby = room.state === "lobby" && now - room.createdAt > 60 * 60 * 1000 && ![...room.players.values()].some((player) => player.connected);
    if (!oldEnded && !abandonedLobby) continue;
    stopGameTimers(room);
    for (const player of room.players.values()) {
      if (player.graceTimer) clearTimeout(player.graceTimer);
      if (player.token) playersByToken.delete(player.token);
      if (player.stream && !player.stream.destroyed) player.stream.end();
    }
    rooms.delete(roomId);
  }
}, 60000);
cleanupTimer.unref?.();

const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (!player.isBot && player.connected && player.lastSeenAt && now - player.lastSeenAt > 24000) {
        disconnectPlayer(player, player.streamId, true);
      }
    }
  }
}, 5000);
heartbeatTimer.unref?.();

server.listen(PORT, () => {
  console.log(`THE VAULT lobby server ready at http://localhost:${PORT}`);
});

function shutdown() {
  clearInterval(cleanupTimer);
  clearInterval(heartbeatTimer);
  for (const room of rooms.values()) {
    stopGameTimers(room);
    for (const player of room.players.values()) {
      if (player.graceTimer) clearTimeout(player.graceTimer);
      if (player.stream && !player.stream.destroyed) player.stream.end();
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
