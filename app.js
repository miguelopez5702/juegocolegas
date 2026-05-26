/* ═══════════════════════════════════════════════════════════
   ¿Quién es más probable?  —  PeerJS Client (GitHub Pages)
   ═══════════════════════════════════════════════════════════
   - One player is the HOST (creates the room).
   - The host's browser manages ALL game state.
   - Other players are CLIENTS that connect via WebRTC (PeerJS).
   - All communication is peer-to-peer, no server needed.
   ═══════════════════════════════════════════════════════════ */

// ── Constants ──────────────────────────────────────────────
const ROOM_PREFIX = 'qemp-';
const ADVANCE_DELAY = 7000;

// ── State ──────────────────────────────────────────────────
let peer = null;
let myName = '';
let roomCode = '';
let isHost = false;
let hasVoted = false;
let isReady = false;

// Host-only state
let hostConns = new Map();
let questions = [];
let gameState = 'lobby';
let currentQuestionIndex = 0;
let currentVotes = new Map();
let stats = {};
let roundHistory = [];
let advanceTimer = null;

// Client-only state
let hostConn = null;

// ── DOM Refs ───────────────────────────────────────────────
const screens = {
  login: document.getElementById('screen-login'),
  connecting: document.getElementById('screen-connecting'),
  lobby: document.getElementById('screen-lobby'),
  question: document.getElementById('screen-question'),
  roundResults: document.getElementById('screen-round-results'),
  gameover: document.getElementById('screen-gameover'),
};

const dom = {
  inputName: document.getElementById('input-name'),
  inputCode: document.getElementById('input-code'),
  btnCreate: document.getElementById('btn-create'),
  btnJoin: document.getElementById('btn-join'),
  loginError: document.getElementById('login-error'),
  connectingText: document.getElementById('connecting-text'),
  roomCodeValue: document.getElementById('room-code-value'),
  btnCopyCode: document.getElementById('btn-copy-code'),
  playerCount: document.getElementById('player-count'),
  playersList: document.getElementById('players-list'),
  btnReady: document.getElementById('btn-ready'),
  btnReadyText: document.querySelector('#btn-ready .btn-text'),
  questionNumber: document.getElementById('question-number'),
  totalQuestions: document.getElementById('total-questions'),
  progressFill: document.getElementById('progress-fill'),
  questionText: document.getElementById('question-text'),
  voteOptions: document.getElementById('vote-options'),
  voteStatus: document.getElementById('vote-status'),
  votesCast: document.getElementById('votes-cast'),
  votesTotal: document.getElementById('votes-total'),
  roundQuestion: document.getElementById('round-question'),
  roundVotes: document.getElementById('round-votes'),
  countdownBar: document.getElementById('countdown-bar'),
  finalRanking: document.getElementById('final-ranking'),
  btnPlayAgain: document.getElementById('btn-play-again'),
};

// ── Screen Management ──────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
  if (name === 'question' && navigator.vibrate) navigator.vibrate(80);
}

// ── Error Display ──────────────────────────────────────────
function showError(msg) {
  dom.loginError.textContent = msg;
  dom.loginError.classList.add('show');
  setTimeout(() => dom.loginError.classList.remove('show'), 5000);
}

// ── Utilities ──────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getInitial(name) {
  return name.charAt(0).toUpperCase();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function log(msg) {
  console.log(`[QEMP] ${msg}`);
}

// Safe send: works with both json serialization and string
function safeSend(conn, obj) {
  try {
    if (conn && conn.open) {
      conn.send(obj);
      return true;
    }
  } catch (e) {
    log('Error sending: ' + e.message);
  }
  return false;
}

// Parse incoming data (handles both object and string)
function parseMsg(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw;
}

// ═══════════════════════════════════════════════════════════
// PEER SETUP
// ═══════════════════════════════════════════════════════════

function createPeer(id) {
  return new Promise((resolve, reject) => {
    const opts = {
      debug: 1, // 1 = errors only in console
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' },
        ],
      },
    };

    log('Creating peer' + (id ? ` with ID: ${id}` : ' with random ID'));
    const p = id ? new Peer(id, opts) : new Peer(opts);

    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        p.destroy();
        reject(new Error('No se pudo conectar al servidor. Comprueba tu conexión a internet.'));
      }
    }, 15000);

    p.on('open', (assignedId) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        log('Peer connected with ID: ' + assignedId);
        resolve(p);
      }
    });

    p.on('error', (err) => {
      log('Peer error: ' + err.type + ' - ' + err.message);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);

        // Translate PeerJS error types to user-friendly messages
        let userMsg = err.message;
        if (err.type === 'unavailable-id') {
          userMsg = 'Esa sala ya existe. Prueba de nuevo.';
        } else if (err.type === 'peer-unavailable') {
          userMsg = 'No se encontró la sala. ¿El código es correcto?';
        } else if (err.type === 'network') {
          userMsg = 'Error de red. Comprueba tu conexión.';
        } else if (err.type === 'server-error') {
          userMsg = 'Servidor no disponible. Inténtalo en unos segundos.';
        }
        reject(new Error(userMsg));
      } else {
        // Error after peer was already created (late error)
        if (err.type === 'peer-unavailable') {
          // Client tried to connect to non-existent room - already handled
          log('Late peer-unavailable error (ignored, handled elsewhere)');
        }
      }
    });

    p.on('disconnected', () => {
      log('Peer disconnected from signaling server');
      // Try to reconnect
      if (!p.destroyed) {
        log('Attempting to reconnect...');
        p.reconnect();
      }
    });
  });
}

// Cleanup peer and connections
function destroyPeer() {
  if (advanceTimer) clearTimeout(advanceTimer);
  if (peer && !peer.destroyed) {
    peer.destroy();
  }
  peer = null;
  hostConn = null;
  hostConns = new Map();
}

// ═══════════════════════════════════════════════════════════
// HOST LOGIC
// ═══════════════════════════════════════════════════════════

async function loadQuestions() {
  const resp = await fetch('preguntas.txt');
  if (!resp.ok) throw new Error('No se encontró el archivo de preguntas');
  const text = await resp.text();
  questions = text.split('\n').map((q) => q.trim()).filter((q) => q.length > 0);
  if (questions.length === 0) throw new Error('El archivo de preguntas está vacío');
  log(`Loaded ${questions.length} questions`);
}

function hostGetPlayersList() {
  const list = [{ name: myName, ready: isReady, isHost: true }];
  for (const [, data] of hostConns) {
    list.push({ name: data.name, ready: data.ready, isHost: false });
  }
  return list;
}

function hostGetPlayerNames() {
  return hostGetPlayersList().map((p) => p.name);
}

function hostBroadcast(msg) {
  for (const [pid, data] of hostConns) {
    safeSend(data.conn, msg);
  }
}

function hostBroadcastPlayers() {
  const players = hostGetPlayersList();
  hostBroadcast({ type: 'players-update', players });
  handlePlayersUpdate(players);
}

function hostHandleMessage(peerId, msg) {
  const data = hostConns.get(peerId);
  if (!data) return;

  switch (msg.type) {
    case 'ready': {
      data.ready = !data.ready;
      hostBroadcastPlayers();
      hostCheckAllReady();
      break;
    }
    case 'vote': {
      if (gameState !== 'playing') break;
      if (currentVotes.has(peerId)) break;
      currentVotes.set(peerId, msg.name);
      const voteUpdate = { type: 'vote-update', voted: currentVotes.size, total: hostGetPlayersList().length };
      hostBroadcast(voteUpdate);
      handleVoteUpdate(voteUpdate);
      if (currentVotes.size === hostGetPlayersList().length) {
        hostShowRoundResults();
      }
      break;
    }
  }
}

function hostCheckAllReady() {
  const players = hostGetPlayersList();
  if (players.length >= 2 && players.every((p) => p.ready)) {
    hostStartGame();
  }
}

function hostStartGame() {
  gameState = 'playing';
  currentQuestionIndex = 0;
  stats = {};
  roundHistory = [];

  for (const p of hostGetPlayersList()) {
    stats[p.name] = 0;
  }

  hostBroadcast({ type: 'game-started' });
  hostSendQuestion();
}

function hostSendQuestion() {
  currentVotes = new Map();
  gameState = 'playing';

  const msg = {
    type: 'new-question',
    question: questions[currentQuestionIndex],
    questionNumber: currentQuestionIndex + 1,
    totalQuestions: questions.length,
    players: hostGetPlayerNames(),
  };

  hostBroadcast(msg);
  handleNewQuestion(msg);
}

function hostShowRoundResults() {
  if (advanceTimer) clearTimeout(advanceTimer);
  gameState = 'showing-results';

  const players = hostGetPlayersList();
  const voteCounts = {};
  for (const p of players) voteCounts[p.name] = 0;
  for (const votedName of currentVotes.values()) {
    if (voteCounts[votedName] !== undefined) voteCounts[votedName]++;
  }
  for (const [name, count] of Object.entries(voteCounts)) {
    stats[name] = (stats[name] || 0) + count;
  }
  roundHistory.push({ question: questions[currentQuestionIndex], votes: { ...voteCounts } });

  const msg = {
    type: 'round-results',
    question: questions[currentQuestionIndex],
    votes: voteCounts,
    stats: { ...stats },
    questionNumber: currentQuestionIndex + 1,
    totalQuestions: questions.length,
  };

  hostBroadcast(msg);
  handleRoundResults(msg);

  advanceTimer = setTimeout(() => {
    currentQuestionIndex++;
    if (currentQuestionIndex >= questions.length) {
      hostEndGame();
    } else {
      hostSendQuestion();
    }
  }, ADVANCE_DELAY);
}

function hostEndGame() {
  const msg = {
    type: 'game-over',
    stats,
    roundHistory,
    totalQuestions: questions.length,
  };

  hostBroadcast(msg);
  handleGameOver(msg);

  gameState = 'lobby';
  currentQuestionIndex = 0;
  currentVotes = new Map();
  isReady = false;
  for (const [, data] of hostConns) data.ready = false;

  setTimeout(() => hostBroadcastPlayers(), 500);
}

function hostHandleDisconnect(peerId) {
  const data = hostConns.get(peerId);
  if (data) log(`Player disconnected: ${data.name}`);
  hostConns.delete(peerId);
  currentVotes.delete(peerId);
  hostBroadcastPlayers();

  if (gameState === 'playing') {
    const total = hostGetPlayersList().length;
    if (total > 0 && currentVotes.size === total) {
      hostShowRoundResults();
    }
  }
}

function hostListenForConnections() {
  peer.on('connection', (conn) => {
    log('Incoming connection from: ' + conn.peer);

    conn.on('data', (raw) => {
      const msg = parseMsg(raw);
      if (!msg) return;

      if (msg.type === 'join') {
        if (gameState !== 'lobby') {
          safeSend(conn, { type: 'error-msg', message: 'El juego ya ha empezado. Espera a que termine.' });
          setTimeout(() => conn.close(), 500);
          return;
        }

        const existing = hostGetPlayerNames();
        if (existing.some((n) => n.toLowerCase() === msg.name.toLowerCase())) {
          safeSend(conn, { type: 'error-msg', message: 'Ese nombre ya está en uso.' });
          setTimeout(() => conn.close(), 500);
          return;
        }

        hostConns.set(conn.peer, { conn, name: msg.name, ready: false });
        log(`Player joined: ${msg.name} (${conn.peer})`);
        safeSend(conn, { type: 'joined', name: msg.name });
        hostBroadcastPlayers();
        return;
      }

      hostHandleMessage(conn.peer, msg);
    });

    conn.on('close', () => hostHandleDisconnect(conn.peer));
    conn.on('error', (err) => {
      log('Connection error from ' + conn.peer + ': ' + err);
      hostHandleDisconnect(conn.peer);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// CLIENT LOGIC
// ═══════════════════════════════════════════════════════════

function clientSend(msg) {
  safeSend(hostConn, msg);
}

function clientHandleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myName = msg.name;
      log('Joined room as: ' + myName);
      showScreen('lobby');
      break;
    case 'error-msg':
      showScreen('login');
      showError(msg.message);
      destroyPeer();
      break;
    case 'players-update':
      handlePlayersUpdate(msg.players);
      break;
    case 'game-started':
      break;
    case 'new-question':
      handleNewQuestion(msg);
      break;
    case 'vote-update':
      handleVoteUpdate(msg);
      break;
    case 'round-results':
      handleRoundResults(msg);
      break;
    case 'game-over':
      handleGameOver(msg);
      break;
  }
}

// ═══════════════════════════════════════════════════════════
// SHARED UI HANDLERS
// ═══════════════════════════════════════════════════════════

function handlePlayersUpdate(players) {
  dom.playerCount.textContent = players.length;
  dom.playersList.innerHTML = players
    .map(
      (p, i) => `
      <div class="player-item ${p.ready ? 'ready' : ''}" style="animation-delay: ${i * 0.06}s">
        <span class="player-avatar">${getInitial(p.name)}</span>
        <span class="player-name">${escapeHtml(p.name)}</span>
        ${p.isHost ? '<span class="player-tag">HOST</span>' : ''}
        <span class="player-status">${p.ready ? '✅' : '⏳'}</span>
      </div>`
    )
    .join('');
}

function handleNewQuestion(data) {
  hasVoted = false;

  dom.questionNumber.textContent = data.questionNumber;
  dom.totalQuestions.textContent = data.totalQuestions;
  dom.progressFill.style.width = `${(data.questionNumber / data.totalQuestions) * 100}%`;
  dom.questionText.textContent = data.question + '?';

  dom.voteOptions.innerHTML = data.players
    .map(
      (name, i) => `
      <button class="btn-vote" data-name="${escapeAttr(name)}" style="animation-delay: ${i * 0.08}s">
        <span class="vote-avatar">${getInitial(name)}</span>
        <span class="vote-name">${escapeHtml(name)}</span>
      </button>`
    )
    .join('');

  dom.voteOptions.querySelectorAll('.btn-vote').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (hasVoted) return;
      hasVoted = true;

      dom.voteOptions.querySelectorAll('.btn-vote').forEach((b) => b.classList.add('disabled'));
      btn.classList.remove('disabled');
      btn.classList.add('selected');

      const votedName = btn.dataset.name;

      if (isHost) {
        currentVotes.set('__host__', votedName);
        const total = hostGetPlayersList().length;
        const voteUpdate = { type: 'vote-update', voted: currentVotes.size, total };
        hostBroadcast(voteUpdate);
        handleVoteUpdate(voteUpdate);
        if (currentVotes.size === total) hostShowRoundResults();
      } else {
        clientSend({ type: 'vote', name: votedName });
      }

      dom.voteStatus.classList.remove('hidden');
      if (navigator.vibrate) navigator.vibrate(40);
    });
  });

  dom.votesCast.textContent = '0';
  dom.votesTotal.textContent = data.players.length;
  dom.voteStatus.classList.add('hidden');

  showScreen('question');
}

function handleVoteUpdate(data) {
  dom.votesCast.textContent = data.voted;
  dom.votesTotal.textContent = data.total;
  if (hasVoted) dom.voteStatus.classList.remove('hidden');
}

function handleRoundResults(data) {
  dom.roundQuestion.textContent = '¿Quién es más probable que ' + data.question + '?';

  const sorted = Object.entries(data.votes).sort((a, b) => b[1] - a[1]);
  const maxVotes = Math.max(...sorted.map(([, v]) => v), 1);

  dom.roundVotes.innerHTML = sorted
    .map(([name, count], i) => {
      const pct = maxVotes > 0 ? (count / maxVotes) * 100 : 0;
      const isWinner = i === 0 && count > 0;
      return `
        <div class="result-row ${isWinner ? 'winner' : ''}" style="animation-delay: ${i * 0.12}s">
          <div class="result-info">
            <span class="result-avatar ${isWinner ? 'winner-avatar' : ''}">${getInitial(name)}</span>
            <span class="result-name">${escapeHtml(name)}</span>
            <span class="result-count">${count} voto${count !== 1 ? 's' : ''}</span>
          </div>
          <div class="result-bar-container">
            <div class="result-bar ${isWinner ? 'winner-bar' : ''}"
                 style="--bar-width: ${pct}%; animation-delay: ${i * 0.12 + 0.2}s"></div>
          </div>
        </div>`;
    })
    .join('');

  dom.countdownBar.style.animation = 'none';
  dom.countdownBar.offsetHeight;
  dom.countdownBar.style.animation = `countdown ${ADVANCE_DELAY / 1000}s linear forwards`;

  showScreen('roundResults');
}

function handleGameOver(data) {
  const sorted = Object.entries(data.stats).sort((a, b) => b[1] - a[1]);
  const maxVotes = sorted.length > 0 ? sorted[0][1] : 1;

  dom.finalRanking.innerHTML = sorted
    .map(([name, totalVotes], i) => {
      const medal = i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      const barPct = maxVotes > 0 ? (totalVotes / maxVotes) * 100 : 0;
      return `
        <div class="ranking-item ${i === 0 ? 'champion' : ''}" style="animation-delay: ${i * 0.15}s">
          <div class="ranking-medal">${medal}</div>
          <div class="ranking-info">
            <span class="ranking-name">${escapeHtml(name)}</span>
            <span class="ranking-votes">${totalVotes} voto${totalVotes !== 1 ? 's' : ''} totales</span>
          </div>
          <div class="ranking-bar-container">
            <div class="ranking-bar" style="--bar-width: ${barPct}%; animation-delay: ${i * 0.15 + 0.3}s"></div>
          </div>
        </div>`;
    })
    .join('');

  showScreen('gameover');
  if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
}

// ═══════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════

// ── Create Room ────────────────────────────────────────────
dom.btnCreate.addEventListener('click', async () => {
  const name = dom.inputName.value.trim();
  if (!name) { showError('Escribe tu nombre'); return; }
  if (name.length > 15) { showError('Nombre demasiado largo (máx. 15)'); return; }

  myName = name;
  isHost = true;

  dom.btnCreate.disabled = true;
  dom.btnJoin.disabled = true;
  showScreen('connecting');
  dom.connectingText.textContent = 'Creando sala…';

  try {
    await loadQuestions();

    // Try up to 3 times with different codes in case of ID conflict
    let attempts = 0;
    while (attempts < 3) {
      roomCode = generateCode();
      try {
        peer = await createPeer(ROOM_PREFIX + roomCode);
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 3) throw err;
        log('Retrying with different code...');
      }
    }

    hostListenForConnections();

    // Also listen for late errors on the peer (e.g. peer-unavailable for clients)
    peer.on('error', (err) => {
      log('Late peer error: ' + err.type + ' - ' + err.message);
    });

    dom.roomCodeValue.textContent = roomCode;
    hostBroadcastPlayers();
    showScreen('lobby');
    log('Room created: ' + roomCode);
  } catch (err) {
    showScreen('login');
    showError(err.message || 'Error al crear la sala');
    destroyPeer();
  } finally {
    dom.btnCreate.disabled = false;
    dom.btnJoin.disabled = false;
  }
});

// ── Join Room ──────────────────────────────────────────────
dom.btnJoin.addEventListener('click', async () => {
  const name = dom.inputName.value.trim();
  const code = dom.inputCode.value.trim().toUpperCase();

  if (!name) { showError('Escribe tu nombre'); return; }
  if (name.length > 15) { showError('Nombre demasiado largo (máx. 15)'); return; }
  if (!code || code.length !== 4) { showError('Introduce el código de 4 caracteres'); return; }

  myName = name;
  isHost = false;
  roomCode = code;

  dom.btnCreate.disabled = true;
  dom.btnJoin.disabled = true;
  showScreen('connecting');
  dom.connectingText.textContent = 'Conectando a la sala…';

  try {
    peer = await createPeer(undefined);

    // Listen for peer-level errors (peer-unavailable fires HERE, not on the connection)
    let joinRejector = null;
    peer.on('error', (err) => {
      log('Peer error while joining: ' + err.type);
      if (err.type === 'peer-unavailable') {
        if (joinRejector) joinRejector(new Error('No se encontró la sala. ¿El código es correcto?'));
      }
    });

    hostConn = peer.connect(ROOM_PREFIX + code, {
      reliable: true,
      serialization: 'json',
    });

    // Register data handler BEFORE open to avoid missing messages
    hostConn.on('data', (raw) => {
      const msg = parseMsg(raw);
      if (msg) clientHandleMessage(msg);
    });

    // Handle host disconnection
    hostConn.on('close', () => {
      log('Disconnected from host');
      alert('El anfitrión se ha desconectado.');
      showScreen('login');
      destroyPeer();
    });

    hostConn.on('error', (err) => {
      log('Connection error: ' + err);
    });

    // Wait for the connection to open
    await new Promise((resolve, reject) => {
      joinRejector = reject;

      const timeout = setTimeout(() => {
        reject(new Error('No se encontró la sala. ¿El código es correcto?'));
      }, 12000);

      hostConn.on('open', () => {
        clearTimeout(timeout);
        log('Connected to host, sending join...');
        safeSend(hostConn, { type: 'join', name });
        resolve();
      });
    });

    dom.roomCodeValue.textContent = roomCode;
    log('Joined room: ' + roomCode);
  } catch (err) {
    showScreen('login');
    showError(err.message || 'Error al conectar');
    destroyPeer();
  } finally {
    dom.btnCreate.disabled = false;
    dom.btnJoin.disabled = false;
  }
});

// ── Enter key on inputs ────────────────────────────────────
dom.inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (dom.inputCode.value.trim()) {
      dom.btnJoin.click();
    } else {
      dom.btnCreate.click();
    }
  }
});

dom.inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.btnJoin.click();
});

dom.inputCode.addEventListener('input', () => {
  dom.inputCode.value = dom.inputCode.value.toUpperCase();
});

// ── Copy room code ─────────────────────────────────────────
dom.btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    dom.btnCopyCode.textContent = '✅';
    setTimeout(() => (dom.btnCopyCode.textContent = '📋'), 2000);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = roomCode;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    dom.btnCopyCode.textContent = '✅';
    setTimeout(() => (dom.btnCopyCode.textContent = '📋'), 2000);
  });
});

// ── Ready Toggle ───────────────────────────────────────────
dom.btnReady.addEventListener('click', () => {
  isReady = !isReady;
  dom.btnReady.classList.toggle('ready', isReady);
  dom.btnReadyText.textContent = isReady ? '¡Listo! ✓' : 'Estoy listo';

  if (isHost) {
    hostBroadcastPlayers();
    hostCheckAllReady();
  } else {
    clientSend({ type: 'ready' });
  }
});

// ── Play Again ─────────────────────────────────────────────
dom.btnPlayAgain.addEventListener('click', () => {
  isReady = false;
  hasVoted = false;
  dom.btnReady.classList.remove('ready');
  dom.btnReadyText.textContent = 'Estoy listo';
  showScreen('lobby');
});
