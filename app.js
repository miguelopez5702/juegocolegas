/* ═══════════════════════════════════════════════════════════
   ¿Quién es más probable?  —  Google Sheets / Apps Script Edition
   ═══════════════════════════════════════════════════════════ */

// ¡IMPORTANTE! Reemplaza esta URL con la URL de tu Web App de Google Apps Script
const API_URL = 'https://script.google.com/macros/s/AKfycbwf3hunx-Z5JDTbfaklBmClidooS28958M6ydn_I9zatLOHpv_C25k8On8gzPfw3Bea/exec';

const ADVANCE_DELAY = 7000;

// ── State ──────────────────────────────────────────────────
let myId = '';
let myName = '';
let roomCode = '';
let isHost = false;
let hasVoted = false;
let isReady = false;

let pollInterval = null;
let lastStateStr = '';

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

// ── API Communication ──────────────────────────────────────
async function apiCall(action, data = {}) {
  data.action = action;
  try {
    const params = new URLSearchParams();
    params.append('data', JSON.stringify(data));
    
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
    return await response.json();
  } catch (error) {
    console.error("API Error:", error);
    return { error: error.message };
  }
}

async function loadQuestions() {
  const resp = await fetch('preguntas.txt');
  if (!resp.ok) throw new Error('No se encontró el archivo de preguntas');
  const text = await resp.text();
  const questions = text.split('\n').map((q) => q.trim()).filter((q) => q.length > 0);
  if (questions.length === 0) throw new Error('El archivo de preguntas está vacío');
  log(`Loaded ${questions.length} questions`);
  return questions;
}

// ── Polling & State Management ─────────────────────────────
async function pollState() {
  if (!roomCode || !myId) return;
  try {
    const response = await fetch(`${API_URL}?action=poll&roomCode=${roomCode}&playerId=${myId}`);
    const data = await response.json();
    
    if (data.error) {
      if (data.error === "Room not found") {
         clearInterval(pollInterval);
         showError("La sala ha sido cerrada o ya no existe.");
         showScreen('login');
      }
      return;
    }
    
    const stateStr = JSON.stringify(data);
    if (stateStr !== lastStateStr) {
      lastStateStr = stateStr;
      handleStateUpdate(data);
    }
  } catch(e) {
    console.error("Poll error:", e);
  }
}

function handleStateUpdate(state) {
  // Update players list
  handlePlayersUpdate(state.players);

  // Manage Screen Transitions
  if (state.gameState === 'lobby') {
    if (!screens.lobby.classList.contains('active')) showScreen('lobby');
    // reset vote state
    hasVoted = false;
  } else if (state.gameState === 'playing') {
    const isNewQuestion = !screens.question.classList.contains('active') || dom.questionNumber.textContent !== String(state.currentQuestionIndex + 1);
    
    if (isNewQuestion) {
        handleNewQuestion(state);
    } else {
        handleVoteUpdate(state);
    }
  } else if (state.gameState === 'showing-results') {
    if (!screens.roundResults.classList.contains('active')) {
        handleRoundResults(state);
    }
  } else if (state.gameState === 'game-over') {
    if (!screens.gameover.classList.contains('active')) {
        handleGameOver(state);
    }
  }

  // Host Logic for auto-advancing rounds
  if (isHost) {
    if (state.gameState === 'lobby') {
      const allReady = state.players.length >= 2 && state.players.every(p => p.ready);
      if (allReady && !window.startingGame) {
         window.startingGame = true;
         hostStartGame();
      }
    } else if (state.gameState === 'showing-results') {
      if (!window.advanceTimer) {
        window.advanceTimer = setTimeout(() => {
          apiCall('nextQuestion', { playerId: myId });
          window.advanceTimer = null;
        }, ADVANCE_DELAY);
      }
    } else {
      if (window.advanceTimer) {
         clearTimeout(window.advanceTimer);
         window.advanceTimer = null;
      }
    }
  }
  
  // Sync my local ready state if needed
  const me = state.players.find(p => p.id === myId);
  if (me) {
      isReady = me.ready;
      dom.btnReady.classList.toggle('ready', isReady);
      dom.btnReadyText.textContent = isReady ? '¡Listo! ✓' : 'Estoy listo';
  }
}

async function hostStartGame() {
  try {
     const questions = await loadQuestions();
     await apiCall('start', { playerId: myId, questions: questions });
  } catch(e) {
     showError(e.message);
  }
  window.startingGame = false;
}

// ── UI Updaters ────────────────────────────────────────────

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

function handleNewQuestion(state) {
  hasVoted = false;

  dom.questionNumber.textContent = state.currentQuestionIndex + 1;
  dom.totalQuestions.textContent = state.totalQuestions;
  dom.progressFill.style.width = `${((state.currentQuestionIndex + 1) / state.totalQuestions) * 100}%`;
  dom.questionText.textContent = state.currentQuestion + '?';

  dom.voteOptions.innerHTML = state.players
    .map(
      (p, i) => `
      <button class="btn-vote" data-name="${escapeAttr(p.name)}" style="animation-delay: ${i * 0.08}s">
        <span class="vote-avatar">${getInitial(p.name)}</span>
        <span class="vote-name">${escapeHtml(p.name)}</span>
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

      apiCall('vote', { playerId: myId, targetName: votedName });

      dom.voteStatus.classList.remove('hidden');
      if (navigator.vibrate) navigator.vibrate(40);
    });
  });

  dom.votesCast.textContent = state.votesCast;
  dom.votesTotal.textContent = state.players.length;
  dom.voteStatus.classList.add('hidden');

  showScreen('question');
}

function handleVoteUpdate(state) {
  dom.votesCast.textContent = state.votesCast;
  dom.votesTotal.textContent = state.players.length;
  if (hasVoted) dom.voteStatus.classList.remove('hidden');
}

function handleRoundResults(state) {
  dom.roundQuestion.textContent = '¿Quién es más probable que ' + state.currentQuestion + '?';

  const sorted = Object.entries(state.roundResults).sort((a, b) => b[1] - a[1]);
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

function handleGameOver(state) {
  const sorted = [...state.players].sort((a, b) => b.stats - a.stats);
  const maxVotes = sorted.length > 0 ? sorted[0].stats : 1;

  dom.finalRanking.innerHTML = sorted
    .map((p, i) => {
      const medal = i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      const barPct = maxVotes > 0 ? (p.stats / maxVotes) * 100 : 0;
      return `
        <div class="ranking-item ${i === 0 ? 'champion' : ''}" style="animation-delay: ${i * 0.15}s">
          <div class="ranking-medal">${medal}</div>
          <div class="ranking-info">
            <span class="ranking-name">${escapeHtml(p.name)}</span>
            <span class="ranking-votes">${p.stats} voto${p.stats !== 1 ? 's' : ''} totales</span>
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

// ── Event Listeners ────────────────────────────────────────

// Create Room
dom.btnCreate.addEventListener('click', async () => {
  if (!API_URL || API_URL.includes('URL_DE_TU_WEB_APP')) {
     showError("No has configurado el API_URL en app.js");
     return;
  }
  const name = dom.inputName.value.trim();
  if (!name) { showError('Escribe tu nombre'); return; }
  if (name.length > 15) { showError('Nombre demasiado largo (máx. 15)'); return; }

  myName = name;

  dom.btnCreate.disabled = true;
  dom.btnJoin.disabled = true;
  showScreen('connecting');
  dom.connectingText.textContent = 'Creando sala en Google Sheets…';

  const res = await apiCall('create', { name: myName });
  
  dom.btnCreate.disabled = false;
  dom.btnJoin.disabled = false;
  
  if (res.error) {
    showScreen('login');
    showError(res.error);
  } else {
    roomCode = res.roomCode;
    myId = res.playerId;
    isHost = res.isHost;
    dom.roomCodeValue.textContent = roomCode;
    showScreen('lobby');
    pollInterval = setInterval(pollState, 2000);
    log('Room created: ' + roomCode);
  }
});

// Join Room
dom.btnJoin.addEventListener('click', async () => {
  if (!API_URL || API_URL.includes('URL_DE_TU_WEB_APP')) {
     showError("No has configurado el API_URL en app.js");
     return;
  }
  const name = dom.inputName.value.trim();
  const code = dom.inputCode.value.trim().toUpperCase();

  if (!name) { showError('Escribe tu nombre'); return; }
  if (name.length > 15) { showError('Nombre demasiado largo (máx. 15)'); return; }
  if (!code || code.length !== 4) { showError('Introduce el código de 4 caracteres'); return; }

  myName = name;
  roomCode = code;

  dom.btnCreate.disabled = true;
  dom.btnJoin.disabled = true;
  showScreen('connecting');
  dom.connectingText.textContent = 'Conectando a la sala…';

  const res = await apiCall('join', { name: myName, roomCode: roomCode });

  dom.btnCreate.disabled = false;
  dom.btnJoin.disabled = false;

  if (res.error) {
    showScreen('login');
    showError(res.error);
  } else {
    myId = res.playerId;
    isHost = res.isHost;
    dom.roomCodeValue.textContent = roomCode;
    showScreen('lobby');
    pollInterval = setInterval(pollState, 2000);
    log('Joined room: ' + roomCode);
  }
});

// Enter key on inputs
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

// Copy room code
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

// Ready Toggle
dom.btnReady.addEventListener('click', () => {
  isReady = !isReady;
  apiCall('ready', { playerId: myId });
});

// Play Again
dom.btnPlayAgain.addEventListener('click', () => {
  if (isHost) {
      apiCall('playAgain', { playerId: myId });
  } else {
      showScreen('lobby'); // The host click will sync everyone else via polling
  }
});
