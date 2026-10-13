(() => {
  const ROLE_NAMES = { hacker: "Hacker", muscle: "Muscle", lookout: "Lookout" };
  const ROLE_GUIDANCE = {
    hacker: "Enter the signal answer to disable the vault lock. On Level 3, the code changes every 30 seconds.",
    muscle: "Wait for the Lookout to say CLEAR before pressing. Breach only when the route is safe.",
    lookout: "Track the patrol route. Call CLEAR only when the guards are away, and warn the crew when one is near."
  };

  const $ = (selector) => document.querySelector(selector);
  const roleCards = [...document.querySelectorAll(".role-card")];
  const modal = $("#howModal");
  const resultModal = $("#resultModal");
  const modalOpeners = [$("#howToPlay"), $("#howToPlayInline")];
  const audioToggle = $("#audioToggle");
  const guardAlert = $("#guardAlert");
  const patrolStatus = $("#patrolStatus");
  const patrolStatusText = $("#patrolStatusText");
  const missionFeedback = $("#missionFeedback");
  const gameFeedback = $("#gameFeedback");
  const vaultStage = $("#vaultStage");
  const startButton = $("#startMission");
  const toast = $("#toast");
  const serverStatus = $("#serverStatus");

  let session = null;
  let eventSource = null;
  let pulseTimer = null;
  let connectionId = null;
  let currentState = null;
  let audioEnabled = true;
  let audioContext;
  let audioMasterGain;
  let audioUnlocked = false;
  let musicTimer = null;
  let musicStep = 0;
  let guardSirenTimer = null;
  let guardSirenWanted = false;
  let audioGeneration = 0;
  let toastTimer;
  let overloadTimer;
  let lastChatSignature = "";
  let resultShown = false;
  let returnFocusTo = null;
  let guardDemoTimer;

  try {
    const storedAudio = localStorage.getItem("vault-audio-enabled");
    if (storedAudio !== null) audioEnabled = storedAudio === "true";
    session = JSON.parse(localStorage.getItem("vault-session") || "null");
  } catch (_) {
    session = null;
  }

  function setServerStatus(message, state = "idle") {
    serverStatus.dataset.state = state;
    serverStatus.querySelector("i").className = "";
    serverStatus.textContent = "";
    const indicator = document.createElement("i");
    serverStatus.append(indicator, document.createTextNode(message));
    const topConnection = $("#topConnection");
    if (topConnection) {
      const dot = document.createElement("span");
      dot.className = "connection-dot";
      topConnection.replaceChildren(dot, document.createTextNode(state === "online" ? " LINK STABLE" : state === "offline" ? " LINK OFFLINE" : " LINKING…"));
      topConnection.dataset.state = state;
    }
  }

  function renderAudioState() {
    audioToggle.setAttribute("aria-pressed", String(audioEnabled));
    audioToggle.setAttribute("aria-label", audioEnabled ? "Mute sound" : "Unmute sound");
    audioToggle.title = audioEnabled ? "Mute sound" : "Unmute sound";
    audioToggle.dataset.audioState = audioEnabled ? "on" : "off";
  }

  function setAudioOutputEnabled(enabled) {
    if (!audioUnlocked || !audioContext || !audioMasterGain) return;
    const now = audioContext.currentTime;
    audioMasterGain.gain.cancelScheduledValues(now);
    audioMasterGain.gain.setTargetAtTime(enabled ? 0.85 : 0, now, enabled ? 0.06 : 0.025);
    if (enabled) {
      startMusic();
      if (guardSirenWanted) scheduleGuardSiren();
    } else {
      stopMusic();
      window.clearTimeout(guardSirenTimer);
      guardSirenTimer = null;
    }
  }

  function ensureAudioContext() {
    if (audioUnlocked && audioContext?.state !== "suspended") return true;
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return false;
        audioContext = new AudioContextClass();
        audioMasterGain = audioContext.createGain();
        audioMasterGain.gain.value = 0;
        audioMasterGain.connect(audioContext.destination);
      }
      audioUnlocked = true;
      const resumed = audioContext.resume();
      if (resumed?.catch) resumed.catch(() => { audioUnlocked = false; });
      setAudioOutputEnabled(audioEnabled);
      return true;
    } catch (_) {
      audioContext = null;
      audioMasterGain = null;
      audioUnlocked = false;
      return false;
    }
  }

  function playVoice(frequency, duration, type, volume, startAt) {
    if (!audioUnlocked || !audioEnabled || !audioContext || !audioMasterGain) return;
    try {
      const oscillator = audioContext.createOscillator();
      const envelope = audioContext.createGain();
      const now = Math.max(audioContext.currentTime, startAt ?? audioContext.currentTime);
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      envelope.gain.setValueAtTime(0.001, now);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.002, volume), now + Math.min(0.025, duration / 4));
      envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);
      oscillator.connect(envelope);
      envelope.connect(audioMasterGain);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.01);
    } catch (_) {
      // A transient device or browser audio error should never block play.
    }
  }

  function playTone(frequency, duration = 0.11, type = "sine", volume = 0.035) {
    playVoice(frequency, duration, type, volume, audioContext?.currentTime);
  }

  function scheduleMusicStep() {
    if (!audioUnlocked || !audioEnabled || !audioContext) return;
    const melody = [440, 659.25, 587.33, 659.25, 392, 587.33, 523.25, 587.33, 349.23, 523.25, 440, 523.25, 392, 587.33, 493.88, 587.33];
    const bass = [110, null, null, null, 130.81, null, null, null, 87.31, null, null, null, 98, null, null, null];
    const step = musicStep % melody.length;
    const when = audioContext.currentTime + 0.025;
    playVoice(melody[step], 0.27, "sawtooth", 0.025, when);
    if (bass[step]) playVoice(bass[step], 0.58, "triangle", 0.035, when);
    if (step % 4 === 0) {
      const chordRoots = [220, 261.63, 174.61, 196];
      const root = chordRoots[Math.floor(step / 4)];
      playVoice(root * 1.5, 0.68, "triangle", 0.012, when);
    }
    musicStep = (step + 1) % melody.length;
  }

  function startMusic() {
    if (musicTimer || !audioUnlocked || !audioEnabled) return;
    scheduleMusicStep();
    musicTimer = window.setInterval(scheduleMusicStep, 360);
  }

  function stopMusic() {
    if (musicTimer) window.clearInterval(musicTimer);
    musicTimer = null;
  }

  function scheduleGuardSiren() {
    if (!guardSirenWanted || !audioUnlocked || !audioEnabled || !audioContext || !audioMasterGain) return;
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(560, now);
    oscillator.frequency.linearRampToValueAtTime(920, now + 0.34);
    oscillator.frequency.linearRampToValueAtTime(560, now + 0.72);
    envelope.gain.setValueAtTime(0.001, now);
    envelope.gain.exponentialRampToValueAtTime(0.07, now + 0.035);
    envelope.gain.setValueAtTime(0.07, now + 0.65);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.74);
    oscillator.connect(envelope);
    envelope.connect(audioMasterGain);
    oscillator.start(now);
    oscillator.stop(now + 0.76);
    guardSirenTimer = window.setTimeout(scheduleGuardSiren, 900);
  }

  function setGuardSiren(active) {
    if (guardSirenWanted === active) {
      if (active && audioUnlocked && audioEnabled && !guardSirenTimer) scheduleGuardSiren();
      return;
    }
    guardSirenWanted = active;
    window.clearTimeout(guardSirenTimer);
    guardSirenTimer = null;
    if (active) scheduleGuardSiren();
  }

  function unlockAudioFromClick(event) {
    if (!event.isTrusted) return;
    if (!ensureAudioContext()) return;
    if (currentState?.state === "running" && currentState.guardNear) setGuardSiren(true);
  }

  document.addEventListener("click", unlockAudioFromClick, { capture: true });
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const button = event.target.closest("button, input[type='button'], input[type='submit'], [role='button']");
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
    // Defer until the target handler runs, so the sound toggle's new state applies.
    window.setTimeout(() => playTone(760, 0.055, "sine", 0.022), 0);
  }, { capture: true });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && audioUnlocked && audioEnabled && audioContext?.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
  });

  function playSequence(notes) {
    if (!audioUnlocked || !audioEnabled) return;
    const generation = audioGeneration;
    notes.forEach(([frequency, delay, duration, type]) => {
      window.setTimeout(() => {
        if (audioEnabled && audioUnlocked && generation === audioGeneration) playTone(frequency, duration, type);
      }, delay);
    });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }

  function renderLeaderboard(entries) {
    const list = $("#leaderboardList");
    const safeEntries = Array.isArray(entries) ? entries.slice(0, 5) : [];
    list.replaceChildren();
    if (safeEntries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "leaderboard-empty";
      empty.textContent = entries === null ? "GLOBAL RECORDS OFFLINE — START THE SERVER" : "NO COMPLETED RUNS YET — SET THE FIRST RECORD";
      list.append(empty);
      return;
    }
    safeEntries.forEach((entry, index) => {
      const row = document.createElement("li");
      row.className = "leaderboard-entry";
      const rank = document.createElement("span");
      rank.className = `leader-rank rank-${index + 1}`;
      rank.textContent = String(index + 1).padStart(2, "0");
      const crew = document.createElement("span");
      crew.className = "leader-crew";
      crew.textContent = Array.isArray(entry.names) ? entry.names.join(" + ") : "UNKNOWN CREW";
      const detail = document.createElement("span");
      detail.className = "leader-detail";
      detail.textContent = Array.isArray(entry.names) && entry.names.length === 1 ? "SOLO RUN" : `${entry.names?.length || 0} OPERATORS`;
      const time = document.createElement("time");
      time.className = "leader-time";
      time.textContent = formatTime(entry.timeTaken);
      time.setAttribute("datetime", `PT${Math.max(0, Number(entry.timeTaken) || 0)}S`);
      const identity = document.createElement("span");
      identity.className = "leader-identity";
      identity.append(crew, detail);
      row.append(rank, identity, time);
      list.append(row);
    });
  }

  function renderChat(messages) {
    const safeMessages = Array.isArray(messages) ? messages.slice(-6) : [];
    const signature = safeMessages.map((message) => message.id).join("|");
    if (signature === lastChatSignature) return;
    lastChatSignature = signature;
    const feed = $("#chatFeed");
    feed.replaceChildren();
    if (!safeMessages.length) {
      const empty = document.createElement("span");
      empty.className = "chat-empty";
      empty.textContent = "NO CALLOUTS YET — SEND A QUICK SIGNAL";
      feed.append(empty);
      return;
    }
    safeMessages.forEach((message) => {
      const line = document.createElement("div");
      line.className = "chat-line";
      const sender = document.createElement("span");
      sender.className = "chat-sender";
      sender.textContent = `${message.name} · ${(ROLE_NAMES[message.role] || "CREW").toUpperCase()}`;
      const text = document.createElement("b");
      text.className = "chat-text";
      text.textContent = message.text;
      line.append(sender, text);
      feed.append(line);
    });
    feed.scrollTop = feed.scrollHeight;
  }

  function triggerSystemOverload(duration = 2600, activator = "HACKER") {
    const overlay = $("#glitchOverlay");
    const alreadyActive = overlay.classList.contains("is-active");
    overlay.querySelector("b").textContent = `SYSTEM OVERLOAD // ${activator.toUpperCase()}`;
    overlay.classList.add("is-active");
    document.body.classList.add("system-glitch");
    window.clearTimeout(overloadTimer);
    overloadTimer = window.setTimeout(() => {
      overlay.classList.remove("is-active");
      document.body.classList.remove("system-glitch");
    }, Math.max(350, duration));
    if (!alreadyActive) playSequence([[180, 0, 0.11, "sawtooth"], [95, 100, 0.18, "square"], [260, 235, 0.14, "sawtooth"]]);
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  }

  function saveSession() {
    try {
      if (session) localStorage.setItem("vault-session", JSON.stringify(session));
      else localStorage.removeItem("vault-session");
    } catch (_) {
      // Session restore is best effort when browser storage is restricted.
    }
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) { /* A server error may have no JSON body. */ }
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Network request failed (${response.status}).`);
    return payload;
  }

  function closeStreams() {
    if (pulseTimer) window.clearInterval(pulseTimer);
    pulseTimer = null;
    if (eventSource) eventSource.close();
    eventSource = null;
    connectionId = null;
  }

  function showGuidance(state) {
    const role = state?.you?.role;
    const roleName = ROLE_NAMES[role] || "CREW";
    const label = $("#roleGuidance small");
    const copy = $("#guidanceText");
    if (!state || !role) {
      label.textContent = "YOUR OBJECTIVE // ROLE UNASSIGNED";
      copy.textContent = "Create or join a room to claim an operator role and receive your mission instructions.";
      return;
    }
    label.textContent = `YOUR OBJECTIVE // ${roleName.toUpperCase()}`;
    if (state.state !== "running") {
      copy.textContent = ROLE_GUIDANCE[role];
      return;
    }
    if (state.paused) {
      copy.textContent = "The mission timer is paused while your disconnected teammate reconnects.";
      return;
    }
    if (state.phase === role) {
      const turnText = {
        hacker: state.level === 3 ? "Your move: solve the shifting code before it changes." : "Your move: enter the signal answer to disable the vault lock.",
        lookout: "Your move: watch the patrol tracker and call CLEAR only when the route is safe.",
        muscle: "Your move: wait for the Lookout to say CLEAR before pressing BREACH."
      };
      copy.textContent = turnText[role];
    } else {
      copy.textContent = role === "muscle"
        ? "Hold position. Wait for the Lookout to say CLEAR before pressing BREACH."
        : `Stand by. The ${ROLE_NAMES[state.phase] || "crew"} is taking the next action.`;
    }
  }

  function setRoleCard(card, player, ownPlayer, roomState) {
    const role = card.dataset.role;
    const name = card.querySelector(".role-copy b");
    const roleText = card.querySelector(".role-copy small");
    const presence = card.querySelector(".role-presence");
    const member = roomState?.players.find((candidate) => candidate.role === role);
    const isOwn = Boolean(member && ownPlayer && member.id === ownPlayer.id);
    const canPick = Boolean(roomState && roomState.state === "lobby" && ownPlayer && (!member || isOwn));

    name.textContent = member ? member.name : "OPEN SLOT";
    roleText.textContent = `${ROLE_NAMES[role].toUpperCase()}${isOwn ? " · YOU" : member?.isBot ? " · AI" : member ? " · CREW" : ""}`;
    presence.replaceChildren();
    if (!member) {
      presence.textContent = "OPEN";
      presence.dataset.state = "open";
    } else if (member.isBot) {
      presence.textContent = "AI READY";
      presence.dataset.state = "bot";
    } else {
      const pip = document.createElement("i");
      presence.append(pip, document.createTextNode(member.connected ? " ONLINE" : " OFFLINE"));
      presence.dataset.state = member.connected ? "online" : "offline";
    }
    card.classList.toggle("is-selected", isOwn);
    card.classList.toggle("is-occupied", Boolean(member));
    card.classList.toggle("is-offline", Boolean(member && !member.connected));
    card.setAttribute("aria-pressed", String(isOwn));
    card.disabled = !canPick;
    card.title = canPick
      ? (isOwn ? "Your current role" : `Choose ${ROLE_NAMES[role]}`)
      : member && !isOwn ? `${member.name} has this role` : "Roles are locked during the heist";
  }

  function showGuardWarning(visible, demo = false) {
    window.clearTimeout(guardDemoTimer);
    guardAlert.classList.toggle("is-visible", visible);
    document.body.classList.toggle("guard-near", visible);
    patrolStatus.classList.toggle("guard-near", visible);
    if (demo && visible) {
      guardDemoTimer = window.setTimeout(() => {
        if (!currentState?.guardNear) {
          setGuardSiren(false);
          showGuardWarning(false);
          patrolStatusText.textContent = "PATROL: ROUTINE";
        }
      }, 2800);
    }
  }

  function updateActionControls(state) {
    const active = state.state === "running" && !state.paused;
    $("#hackControls").hidden = !(active && state.you?.role === "hacker");
    $("#lookoutControls").hidden = !(active && state.you?.role === "lookout");
    $("#muscleControls").hidden = !(active && state.you?.role === "muscle");
    $("#gameConsole").hidden = state.state !== "running";
    $("#puzzleHint").textContent = state.puzzleHint || "— + — = ?";
    $("#codeRotationHint").textContent = state.level === 3 ? `CODE RESETS IN ${state.codeChangesIn ?? 30}s` : "";
    $("#phaseLabel").textContent = state.phase === "hacker" ? "HACKER ACTION" : state.phase === "lookout" ? "LOOKOUT ACTION" : "MUSCLE ACTION";
    const phaseCopy = {
      hacker: "Solve the signal to disable the lock.",
      lookout: state.guardNear ? "Guard nearby. Wait until the route is clear." : "Confirm the route is safe for the breach.",
      muscle: state.guardNear ? "Hold position until the patrol clears." : "Wait for CLEAR, then breach the door."
    };
    $("#phaseInstruction").textContent = active ? phaseCopy[state.phase] || "Wait for the crew." : "The operation is paused.";
    // Keep each operator's control visible during the run. The server validates
    // timing and records premature presses in the end-of-run stats.
    $("#codeInput").disabled = !active;
    $("#callClear").disabled = !active;
    $("#breachDoor").disabled = !active;
    $("#systemOverload").disabled = !active || !state.overloadAvailable;
    $("#overloadCharges").textContent = `${state.overloadCharges ?? 3} CHARGES`;
    const me = state.players.find((player) => player.id === state.you?.id);
    document.querySelectorAll("[data-chat]").forEach((button) => {
      button.disabled = state.state !== "running" || !me?.connected;
    });
  }

  function showResult(state) {
    if (!state.result || resultShown) return;
    resultShown = true;
    const won = Boolean(state.result.won);
    $("#resultOutcome").textContent = won ? "COMPLETE" : "FAILED";
    $("#resultOutcome").classList.toggle("result-loss", !won);
    $("#resultReason").textContent = state.result.detail || (won ? "The crew made it out with the take." : "The operation ended before the crew escaped.");
    $("#statTime").textContent = formatTime(state.stats?.timeTaken);
    $("#statWrong").textContent = String(state.stats?.wrongButtons ?? 0);
    $("#statSpotted").textContent = String(state.stats?.guardSightings ?? 0);
    $("#statLevel").textContent = `${state.result.levelReached || state.level} / 3`;
    resultModal.classList.add("is-open");
    resultModal.setAttribute("aria-hidden", "false");
    $("#closeResultDone").focus();
    if (won) playSequence([[392, 0, 0.12, "sine"], [523, 130, 0.15, "sine"], [659, 300, 0.22, "sine"]]);
  }

  function applyState(state, playerId, eventType = "", eventDetail = {}) {
    if (!state) return;
    const previousState = currentState;
    currentState = state;
    const you = state.players.find((player) => player.id === (playerId || state.you?.id)) || null;
    if (session && you) session.name = you.name;

    $("#roomConnectFields").hidden = true;
    $("#roomConnectedFields").hidden = false;
    $("#roomCodeDisplay").textContent = state.roomId;
    $("#roomIdInRoster").textContent = `ROOM ${state.roomId}`;
    const displayedPlayers = state.state === "lobby" ? state.players.filter((player) => !player.isBot).length : state.players.length;
    $("#roomPlayerCount").textContent = `${displayedPlayers} / 3`;
    const modeText = state.state === "running"
      ? state.mode === "solo-ai" ? "SOLO + AI" : state.mode === "crew-ai" ? "CREW + AI" : "LIVE HEIST"
      : state.state === "ended" ? "REPORT READY" : "WAITING ROOM";
    $("#roomMode").textContent = modeText;
    $("#crewCount").textContent = String(state.players.length).padStart(2, "0");
    $("#crewReadyLabel").textContent = state.state === "running" ? (state.paused ? "MISSION PAUSED" : "HEIST LIVE") : state.state === "ended" ? "RUN COMPLETE" : `${state.players.filter((player) => player.connected && !player.isBot).length} / 3 READY`;
    $("#crewReadyDetail").textContent = state.state === "lobby"
      ? state.players.length < 3 ? "AI BOTS FILL OPEN ROLES AT START" : "ALL OPERATORS CONNECTED"
      : state.paused ? "RECONNECT WINDOW ACTIVE" : state.mode === "solo-ai" ? "AI CREW SUPPORT ENABLED" : "ALL OPERATORS CONNECTED";

    roleCards.forEach((card) => setRoleCard(card, you, you, state));
    $("#rotateRoles").disabled = state.state !== "lobby" || !state.you?.isHost;
    $("#leaveRoom").disabled = state.state === "running";
    $("#leaveRoom").title = state.state === "running" ? "Close the tab to trigger the reconnect grace period." : "Leave this room";
    $("#startMission").disabled = !state.you?.isHost || state.state !== "lobby" || state.disconnected.length > 0;
    if (state.state === "lobby") {
      const humans = state.players.filter((player) => !player.isBot).length;
      startButton.querySelector("span:first-child").textContent = humans < 3 ? "START WITH AI CREW" : "BEGIN OPERATION";
    } else if (state.state === "running") {
      startButton.querySelector("span:first-child").textContent = state.paused ? "MISSION PAUSED" : "HEIST IN PROGRESS";
      startButton.disabled = true;
    } else {
      startButton.querySelector("span:first-child").textContent = state.result?.won ? "HEIST COMPLETE" : "OPERATION FAILED";
      startButton.disabled = true;
    }

    const disconnectBanner = $("#disconnectBanner");
    const disconnected = state.disconnected || [];
    disconnectBanner.hidden = !state.paused || disconnected.length === 0;
    if (disconnected.length === 1) {
      $("#disconnectMessage").textContent = `${ROLE_NAMES[disconnected[0].role] || disconnected[0].name} has disconnected. Waiting for reconnection...`;
    } else if (disconnected.length > 1) {
      $("#disconnectMessage").textContent = `${disconnected.map((member) => ROLE_NAMES[member.role] || member.name).join(" and ")} have disconnected. Waiting for reconnection...`;
    }
    $("#reconnectCountdown").textContent = String(state.reconnectSeconds ?? 30);

    $("#timerMetric").innerHTML = `${formatTime(state.timeRemaining)} <em>MIN</em>`;
    $("#levelMetric").textContent = `L${state.level} · ${state.guards} ${state.guards === 1 ? "GUARD" : "GUARDS"}`;
    $("#lockState").textContent = state.state !== "running" ? "SEALED" : state.phase === "hacker" ? "ENCRYPTED" : state.phase === "ended" ? "OPEN" : "SECURITY OFF";
    $("#gameFeedback").textContent = state.paused ? "MISSION TIMER PAUSED — WAITING FOR RECONNECTION." : state.message || "";
    missionFeedback.textContent = state.message || "";

    document.querySelectorAll("[data-level-step]").forEach((step) => {
      const number = Number(step.dataset.levelStep);
      step.classList.toggle("is-current", number === state.level && state.state === "running");
      step.classList.toggle("is-complete", number < state.level || (number === state.level && state.state === "ended" && state.result?.won));
    });
    updateActionControls(state);
    renderChat(state.chat);
    showGuidance(state);

    const near = Boolean(state.guardNear && state.state === "running");
    setGuardSiren(near);
    showGuardWarning(near);
    patrolStatusText.textContent = near ? `PATROL: GUARD NEAR · ${state.guards} ACTIVE` : state.phase === "muscle" ? "PATROL: ROUTE CLEAR" : "PATROL: ROUTINE";
    $(".patrol-timer b").textContent = formatTime(state.patrolSecondsUntilClear).slice(3);
    $("#guardDemo").hidden = state.state === "running";

    if (eventType === "level-complete") {
      vaultStage.classList.add("is-opening");
      window.setTimeout(() => {
        if (currentState?.state === "running") vaultStage.classList.remove("is-opening");
      }, 1500);
      playSequence([[320, 0, 0.2, "sawtooth"], [440, 180, 0.2, "sine"]]);
      gameFeedback.textContent = `LEVEL ${state.level - 1} CLEAR — ${state.levelName} IS LIVE.`;
    }
    if (eventType === "game-started") {
      resultShown = false;
      vaultStage.classList.remove("is-opening");
      playSequence([[220, 0, 0.42, "sawtooth"], [330, 260, 0.35, "sine"], [494, 560, 0.22, "sine"]]);
    }
    if (eventType === "game-ended" && state.result?.won) vaultStage.classList.add("is-opening");
    if (eventType === "system-overload" || (state.overloadActive && !previousState?.overloadActive)) {
      triggerSystemOverload(eventDetail.duration || state.overloadRemaining || 2600, eventDetail.activator || "HACKER");
      showToast("SYSTEM OVERLOAD — PATROL CAMERAS SCRAMBLED");
    }
    if (eventType === "system-restored") {
      window.clearTimeout(overloadTimer);
      $("#glitchOverlay").classList.remove("is-active");
      document.body.classList.remove("system-glitch");
    }
    if (eventType === "game-resumed") showToast("CREW RECONNECTED — MISSION RESUMED");
    if (eventType === "player-disconnected" && state.state === "running") playSequence([[660, 0, 0.09, "square"], [440, 115, 0.12, "square"]]);
    if (eventType === "code-changed") {
      $("#codeInput").value = "";
      showToast("SECURITY SIGNAL CHANGED — DECRYPT THE NEW CODE");
    }
    if (state.state === "ended" && previousState?.state !== "ended") showResult(state);
    if (eventType === "game-ended") showResult(state);
    if (eventType === "player-joined" && state.players.length > 1) showToast("NEW OPERATOR JOINED THE ROOM");
  }

  async function roomRequest(endpoint, body) {
    try {
      const response = await request(endpoint, body);
      if (response.state) applyState(response.state, response.state.you?.id);
      return response;
    } catch (error) {
      showToast(error.message);
      gameFeedback.textContent = error.message;
      throw error;
    }
  }

  function startEventStream() {
    closeStreams();
    if (!session?.token) return;
    eventSource = new EventSource(`/api/events?token=${encodeURIComponent(session.token)}`);
    eventSource.onopen = () => setServerStatus(`SECURE LINK ACTIVE · ROOM ${session.roomId}`, "online");
    eventSource.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data);
        if (payload.connectionId) connectionId = payload.connectionId;
        if (Array.isArray(payload.leaderboard)) renderLeaderboard(payload.leaderboard);
        if (payload.state) applyState(payload.state, payload.playerId, payload.type, payload);
        if (payload.type === "player-reconnected" && currentState?.state === "running") showToast("OPERATOR RECONNECTED");
      } catch (_) {
        setServerStatus("RECEIVED AN INVALID ROOM UPDATE", "offline");
      }
    };
    eventSource.onerror = () => {
      if (session) setServerStatus("RECONNECTING TO VAULT NETWORK…", "offline");
    };
    pulseTimer = window.setInterval(async () => {
      if (!session?.token || !connectionId) return;
      try {
        await request("/api/pulse", { token: session.token, connectionId });
      } catch (_) {
        // EventSource reconnects automatically; its new stream gets a new id.
      }
    }, 8000);
  }

  async function connectWith(payload) {
    session = { token: payload.token, roomId: payload.roomId, name: payload.name };
    saveSession();
    resultShown = false;
    if (payload.state) applyState(payload.state, payload.playerId);
    setServerStatus("SECURE LINK ACTIVE · WAITING FOR ROOM STREAM", "online");
    startEventStream();
  }

  function openModal(event) {
    returnFocusTo = event.currentTarget;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    $("#closeModal").focus();
  }

  function closeHowModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    returnFocusTo?.focus();
  }

  function closeResultModal() {
    resultModal.classList.remove("is-open");
    resultModal.setAttribute("aria-hidden", "true");
    $("#closeResultDone").blur();
  }

  modalOpeners.forEach((button) => button.addEventListener("click", openModal));
  $("#closeModal").addEventListener("click", closeHowModal);
  $("#modalDone").addEventListener("click", closeHowModal);
  modal.addEventListener("click", (event) => { if (event.target === modal) closeHowModal(); });
  $("#closeResult").addEventListener("click", closeResultModal);
  $("#closeResultDone").addEventListener("click", closeResultModal);
  resultModal.addEventListener("click", (event) => { if (event.target === resultModal) closeResultModal(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (resultModal.classList.contains("is-open")) closeResultModal();
      else if (modal.classList.contains("is-open")) closeHowModal();
    }
  });

  audioToggle.addEventListener("click", () => {
    audioEnabled = !audioEnabled;
    audioGeneration += 1;
    renderAudioState();
    try { localStorage.setItem("vault-audio-enabled", String(audioEnabled)); } catch (_) { /* Optional preference. */ }
    setAudioOutputEnabled(audioEnabled);
    showToast(audioEnabled ? "AUDIO CHANNEL ONLINE" : "AUDIO MUTED");
  });

  $("#createRoom").addEventListener("click", async () => {
    const name = $("#callsignInput").value.trim();
    try {
      const payload = await request("/api/rooms/create", { name });
      await connectWith(payload);
      showToast(`ROOM ${payload.roomId} CREATED`);
    } catch (error) {
      setServerStatus(error.message, "offline");
      showToast(error.message);
    }
  });

  $("#joinRoom").addEventListener("click", async () => {
    const name = $("#callsignInput").value.trim();
    const roomId = $("#roomCodeInput").value.trim().toUpperCase();
    if (!roomId) return showToast("ENTER A ROOM CODE FIRST");
    try {
      const payload = await request("/api/rooms/join", { name, roomId });
      await connectWith(payload);
      showToast(`JOINED ROOM ${payload.roomId}`);
    } catch (error) {
      setServerStatus(error.message, "offline");
      showToast(error.message);
    }
  });

  $("#roomCodeInput").addEventListener("input", (event) => {
    event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });
  $("#roomCodeInput").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#joinRoom").click(); });

  roleCards.forEach((card) => card.addEventListener("click", async () => {
    if (!session) return showToast("CREATE OR JOIN A ROOM TO PICK A ROLE");
    try { await roomRequest("/api/rooms/role", { token: session.token, role: card.dataset.role }); }
    catch (_) { /* The shared server status and toast explain the rejected role. */ }
  }));

  $("#rotateRoles").addEventListener("click", async () => {
    if (!session) return;
    try {
      await roomRequest("/api/rooms/rotate", { token: session.token });
      showToast("CREW ROLES ROTATED");
    } catch (_) { /* Permission and room-state errors are shown by roomRequest. */ }
  });

  startButton.addEventListener("click", async () => {
    if (!session || !currentState?.you?.isHost) return showToast("ONLY THE ROOM HOST CAN START THE HEIST");
    try {
      await roomRequest("/api/rooms/start", { token: session.token });
      showToast("OPERATION LIVE — GOOD LUCK, CREW");
    } catch (_) { /* Server response is surfaced in the mission feedback. */ }
  });

  async function takeAction(action, value) {
    if (!session) return;
    try {
      const response = await roomRequest("/api/rooms/action", { token: session.token, action, value });
      if (action === "SUBMIT_CODE") $("#codeInput").value = "";
      if (response.state?.message) gameFeedback.textContent = response.state.message;
    } catch (_) { /* Invalid timing and role actions are reflected in the room state. */ }
  }

  $("#codeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    takeAction("SUBMIT_CODE", $("#codeInput").value.trim());
  });
  $("#callClear").addEventListener("click", () => takeAction("CALL_CLEAR"));
  $("#breachDoor").addEventListener("click", () => takeAction("BREACH"));
  $("#systemOverload").addEventListener("click", () => takeAction("SYSTEM_OVERLOAD"));
  document.querySelectorAll("[data-chat]").forEach((button) => button.addEventListener("click", async () => {
    if (!session) return;
    try {
      await roomRequest("/api/rooms/chat", { token: session.token, message: button.dataset.chat });
    } catch (_) { /* The server response is shown in the comms status. */ }
  }));

  $("#leaveRoom").addEventListener("click", async () => {
    if (!session) return;
    try {
      await request("/api/rooms/leave", { token: session.token });
      closeStreams();
      session = null;
      currentState = null;
      resultShown = false;
      saveSession();
      $("#roomConnectFields").hidden = false;
      $("#roomConnectedFields").hidden = true;
      $("#disconnectBanner").hidden = true;
      $("#gameConsole").hidden = true;
      $("#roomIdInRoster").textContent = "NO ROOM";
      $("#lockState").textContent = "SEALED";
      vaultStage.classList.remove("is-opening");
      roleCards.forEach((card) => setRoleCard(card, null, null, null));
      startButton.disabled = true;
      startButton.querySelector("span:first-child").textContent = "BEGIN OPERATION";
      $("#rotateRoles").disabled = true;
      $("#crewCount").textContent = "00";
      $("#crewReadyLabel").textContent = "NO ROOM";
      $("#crewReadyDetail").textContent = "CREATE OR JOIN TO BRIEF";
      $("#timerMetric").innerHTML = "--:-- <em>MIN</em>";
      $("#levelMetric").textContent = "—";
      showGuidance(null);
      setServerStatus("CONNECTED · CREATE OR JOIN A ROOM", "online");
      closeResultModal();
    } catch (error) {
      showToast(error.message);
    }
  });

  $("#guardDemo").addEventListener("click", () => {
    if (currentState?.state === "running") return;
    patrolStatusText.textContent = "PATROL: GUARD NEAR";
    setGuardSiren(true);
    showGuardWarning(true, true);
  });

  // A graceful tab close gives the server an immediate signal. SSE close remains
  // the fallback if the browser or network cannot deliver the beacon.
  window.addEventListener("pagehide", (event) => {
    if (event.persisted || !session?.token || !connectionId || !navigator.sendBeacon) return;
    const body = new Blob([JSON.stringify({ token: session.token, connectionId })], { type: "application/json" });
    navigator.sendBeacon("/api/disconnect", body);
  });

  async function initialize() {
    renderAudioState();
    showGuidance(null);
    try {
      await request("/api/health");
      setServerStatus("VAULT NETWORK ONLINE · CREATE OR JOIN A ROOM", "online");
      try {
        const board = await request("/api/leaderboard");
        renderLeaderboard(board.entries);
      } catch (_) {
        renderLeaderboard(null);
      }
    } catch (_) {
      setServerStatus("SERVER OFFLINE · START server.js TO CONNECT", "offline");
      renderLeaderboard(null);
      return;
    }
    if (!session?.token || !session?.roomId) return;
    try {
      const payload = await request(`/api/session?token=${encodeURIComponent(session.token)}`);
      session.name = payload.name;
      saveSession();
      applyState(payload.state, payload.playerId);
      startEventStream();
    } catch (error) {
      session = null;
      saveSession();
      setServerStatus("SAVED ROOM SESSION EXPIRED · CREATE OR JOIN AGAIN", "offline");
      showToast(error.message);
    }
  }

  window.VaultLobby = Object.freeze({
    get state() { return currentState; },
    get session() { return session ? { ...session } : null; },
    reconnect: startEventStream
  });

  initialize();
})();
