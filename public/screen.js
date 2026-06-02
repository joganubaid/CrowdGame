// State configuration
const SCREEN_STATE = {
  LOBBY: 'lobby',
  PLAYING: 'playing',
  COMPLETE: 'complete',
  WORDCLOUD: 'wordcloud'
};

let currentState = SCREEN_STATE.LOBBY;
let socket = null;
let roomCode = '';
let startTime = null;

// Canvas assets
let bgCanvas = null;
let bgCtx = null;
let puzzleCanvas = null;
let puzzleCtx = null;

let stars = [];
let particles = [];
let animationFrameId = null;
let confettiInterval = null; // Tracked so we can clear it between games

// Game State
let puzzleImage = new Image();
let puzzleData = null; // Contains coordinates, pieces info
let dragPositions = new Map(); // pieceId -> { currentX, currentY } (for live drag visualizers)

// Procedural Audio Synthesizer (Same synth engine as desktop.js for zero asset load!)
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

const Sound = {
  playSnap() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.08);
    osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.2);
    
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  },

  playComplete() {
    if (!audioCtx) return;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(261.63, audioCtx.currentTime); // C4
    osc1.frequency.setValueAtTime(329.63, audioCtx.currentTime + 0.15); // E4
    osc1.frequency.setValueAtTime(392.00, audioCtx.currentTime + 0.3); // G4
    osc1.frequency.setValueAtTime(523.25, audioCtx.currentTime + 0.45); // C5
    
    osc2.frequency.setValueAtTime(523.25, audioCtx.currentTime);
    
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.2);
    
    osc1.start();
    osc2.start();
    osc1.stop(audioCtx.currentTime + 1.2);
    osc2.stop(audioCtx.currentTime + 1.2);
  }
};

// Particle effects
function spawnSparks(x, y, color, count = 25) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 2;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 5 + 2,
      color,
      alpha: 1,
      decay: Math.random() * 0.02 + 0.01
    });
  }
}

// 1. STARFIELD BACKGROUND (Parallax)
function initStars() {
  stars = [];
  const numStars = 80;
  for (let i = 0; i < numStars; i++) {
    stars.push({
      x: Math.random() * bgCanvas.width,
      y: Math.random() * bgCanvas.height,
      size: Math.random() * 2 + 0.5,
      speed: Math.random() * 0.5 + 0.1
    });
  }
}

function updateStars() {
  stars.forEach(s => {
    s.y += s.speed;
    if (s.y > bgCanvas.height) {
      s.y = 0;
      s.x = Math.random() * bgCanvas.width;
    }
  });
}

function drawBackground() {
  // Theme-aware backdrop
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  bgCtx.fillStyle = dark ? '#14110E' : '#F1EADA';
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);

  // Soft tangerine glow rising from the bottom in the lobby
  if (currentState === SCREEN_STATE.LOBBY) {
    const glowGrad = bgCtx.createRadialGradient(
      bgCanvas.width / 2, bgCanvas.height * 0.85, 50,
      bgCanvas.width / 2, bgCanvas.height * 0.85, bgCanvas.width * 0.6
    );
    glowGrad.addColorStop(0, 'rgba(255, 90, 44, 0.16)');
    glowGrad.addColorStop(1, 'rgba(255, 90, 44, 0)');
    bgCtx.fillStyle = glowGrad;
    bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  }

  // Drifting confetti dots
  bgCtx.fillStyle = dark ? '#F2EADB' : '#1B1714';
  stars.forEach(s => {
    bgCtx.globalAlpha = s.speed * (dark ? 0.4 : 0.45);
    bgCtx.beginPath();
    bgCtx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    bgCtx.fill();
  });
  bgCtx.globalAlpha = 1.0;
}

// 2. SOCKET CONNECTIONS
function setupConnection() {
  // Extract roomCode from URI path e.g. /screen/ABCD
  const pathParts = window.location.pathname.split('/');
  roomCode = pathParts[pathParts.length - 1].toUpperCase();

  if (!roomCode || roomCode === 'SCREEN') {
    document.getElementById('joinUrlVal').textContent = 'Error: Invalid Room Code. Setup via Admin Panel first.';
    return;
  }

  document.getElementById('roomCodeVal').textContent = roomCode;
  document.getElementById('hudRoomCode').textContent = roomCode;

  // Retrieve QR config data dynamically pointing to correct hostname
  fetch(`/api/room/config?roomCode=${roomCode}`)
    .then(res => res.json())
    .then(config => {
      document.getElementById('joinUrlVal').textContent = config.joinUrl;
      document.getElementById('qrcode').innerHTML = `<img src="${config.qrDataUrl}" alt="QR code" />`;
    })
    .catch(err => console.error('Error fetching QR config:', err));

  socket = io();

  // Register as host
  socket.emit('host-room', roomCode);

  socket.on('room-created', (data) => {
    console.log('Room registered on server:', data);
  });

  socket.on('player-joined', (player) => {
    initAudio();
    addPlayerToLobbyGrid(player);
  });

  socket.on('player-left', (player) => {
    removePlayerFromLobbyGrid(player.id);
  });

  socket.on('room-update', (data) => {
    document.getElementById('playerCount').textContent = data.participantsCount;
  });

  // Event: Activity starts!
  socket.on('activity-start', (data) => {
    if (data.type === 'jigsaw') {
      startJigsawPuzzle(data.state);
    } else if (data.type === 'wordcloud') {
      startWordCloud(data.state);
    }
  });

  // Word cloud refreshed (submission, vote, or moderation)
  socket.on('wordcloud-update', (state) => { renderWordCloud(state); });
  // Host closed the word cloud — reveal the summary
  socket.on('wordcloud-closed', (summary) => { showWordCloudSummary(summary); });

  // Event: Piece dragged/moved by player
  socket.on('piece-move', (data) => {
    const { pieceId, currentX, currentY } = data;
    dragPositions.set(pieceId, { currentX, currentY });
  });

  // Event: Piece snapped correctly
  socket.on('piece-placed', (data) => {
    const { pieceId, correctX, correctY, placedBy, progress, isSolved } = data;
    
    // Snapped piece removes its temporary live dragging marker
    dragPositions.delete(pieceId);
    
    if (puzzleData) {
      const piece = puzzleData.pieces.find(p => p.id === pieceId);
      if (piece) {
        piece.isPlaced = true;
        piece.currentX = correctX;
        piece.currentY = correctY;
        piece.placedByName = placedBy;
      }
    }

    // Play snapping audio and show visual toast
    Sound.playSnap();
    spawnSparks(correctX + (puzzleData.pieceWidth / 2), correctY + (puzzleData.pieceHeight / 2), '#FF5A2C');
    spawnSparks(correctX + (puzzleData.pieceWidth / 2), correctY + (puzzleData.pieceHeight / 2), '#6C4CE0');
    
    // Ticker announcement
    const ticker = document.getElementById('activityTicker');
    ticker.textContent = `🎯 ${placedBy} placed piece (${progress}% solved)`;
    ticker.classList.add('pulse');
    setTimeout(() => ticker.classList.remove('pulse'), 400);

    // Update HUD
    document.getElementById('hudProgressFill').style.width = `${progress}%`;
    document.getElementById('hudProgressText').textContent = `${progress}%`;
  });

  // Event: Puzzle solved!
  socket.on('activity-complete', (data) => {
    triggerPuzzleCompletion(data);
  });
}

// 3. LOBBY UTILITIES
function addPlayerToLobbyGrid(player) {
  const grid = document.getElementById('playerGrid');
  // Check if already in grid
  if (document.getElementById(`p-${player.id}`)) return;

  const div = document.createElement('div');
  div.id = `p-${player.id}`;
  div.className = 'player-avatar';
  div.style.borderColor = player.color;
  div.textContent = player.displayName.toUpperCase();
  grid.appendChild(div);

  document.getElementById('playerCount').textContent = grid.children.length;
}

function removePlayerFromLobbyGrid(playerId) {
  const element = document.getElementById(`p-${playerId}`);
  if (element) {
    element.remove();
  }
  const grid = document.getElementById('playerGrid');
  document.getElementById('playerCount').textContent = grid.children.length;
}

// 4. JIGSAW PUZZLE DRAW ENGINE
function startJigsawPuzzle(state) {
  currentState = SCREEN_STATE.PLAYING;
  startTime = new Date();

  // Clear any leftover confetti from a previous completed game
  if (confettiInterval !== null) {
    clearInterval(confettiInterval);
    confettiInterval = null;
  }

  // Transition views — must add 'active' to bring opacity from 0 → 1
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('hidden');
  document.getElementById('gameplayScreen').classList.remove('hidden');
  document.getElementById('gameplayScreen').classList.add('active');

  puzzleData = state;
  if (state.pieces) {
    preCachePieceImages(state.pieces);
  }
  puzzleImage.src = state.imageUrl;
  
  // Pre-load image
  puzzleImage.onload = () => {
    console.log('Puzzle source image loaded successfully.');
  };
  puzzleImage.onerror = (err) => {
    console.error('Failed to load puzzle source image:', err);
  };

  // Sync initial HUD
  document.getElementById('hudProgressFill').style.width = `${state.progress}%`;
  document.getElementById('hudProgressText').textContent = `${state.progress}%`;
}

function updateJigsaw() {
  if (currentState !== SCREEN_STATE.PLAYING || !puzzleData) return;

  // Let unplaced pieces drift gently on screen edges to look active
  puzzleData.pieces.forEach(p => {
    if (!p.isPlaced) {
      // If the piece is currently being dragged, pull it towards the drag position.
      // Otherwise, let it drift slowly in its spot.
      const dragPos = dragPositions.get(p.id);
      if (dragPos) {
        // Interp towards player drag coordinates
        p.currentX += (dragPos.currentX - p.currentX) * 0.2;
        p.currentY += (dragPos.currentY - p.currentY) * 0.2;
      } else {
        // Natural drift
        p.currentX += Math.sin(Date.now() / 1500 + p.row) * 0.15;
        p.currentY += Math.cos(Date.now() / 1500 + p.col) * 0.15;
      }
    }
  });

  // Update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.x += pt.vx;
    pt.y += pt.vy;
    pt.alpha -= pt.decay;
    if (pt.alpha <= 0) {
      particles.splice(i, 1);
    }
  }
}

function drawJigsaw() {
  if (currentState !== SCREEN_STATE.PLAYING || !puzzleData) return;

  puzzleCtx.clearRect(0, 0, puzzleCanvas.width, puzzleCanvas.height);

  // 1. Draw faded background guidelines image (Ghost)
  if (puzzleImage.complete) {
    puzzleCtx.save();
    puzzleCtx.globalAlpha = 0.13;
    puzzleCtx.drawImage(puzzleImage, 0, 0, puzzleCanvas.width, puzzleCanvas.height);
    puzzleCtx.restore();
  }

  // 2. Draw Grid Lines (theme-aware so they read on dark boards too)
  const darkBoard = document.documentElement.getAttribute('data-theme') === 'dark';
  puzzleCtx.strokeStyle = darkBoard ? 'rgba(242, 234, 219, 0.18)' : 'rgba(27, 23, 20, 0.16)';
  puzzleCtx.lineWidth = 1;
  for (let r = 0; r <= puzzleData.rows; r++) {
    const y = r * puzzleData.pieceHeight;
    puzzleCtx.beginPath();
    puzzleCtx.moveTo(0, y);
    puzzleCtx.lineTo(puzzleCanvas.width, y);
    puzzleCtx.stroke();
  }
  for (let c = 0; c <= puzzleData.cols; c++) {
    const x = c * puzzleData.pieceWidth;
    puzzleCtx.beginPath();
    puzzleCtx.moveTo(x, 0);
    puzzleCtx.lineTo(x, puzzleCanvas.height);
    puzzleCtx.stroke();
  }

  // 3. Draw Placed pieces first (lower layer)
  puzzleData.pieces.forEach(p => {
    if (p.isPlaced && p.imgElement) {
      puzzleCtx.drawImage(
        p.imgElement,
        p.currentX,
        p.currentY,
        puzzleData.pieceWidth,
        puzzleData.pieceHeight
      );
    }
  });

  // 4. Draw Floating unplaced pieces (upper layer with neon border glows)
  puzzleData.pieces.forEach(p => {
    if (!p.isPlaced && p.imgElement) {
      puzzleCtx.save();
      // Draw a crisp tangerine frame around floating (unplaced) pieces
      puzzleCtx.shadowBlur = 0;
      puzzleCtx.strokeStyle = 'rgba(255, 90, 44, 0.95)';
      puzzleCtx.lineWidth = 3;
      // Use puzzleData.pieceHeight (p.pieceHeight is not in the screen state payload)
      puzzleCtx.strokeRect(p.currentX, p.currentY, puzzleData.pieceWidth, puzzleData.pieceHeight);

      // Draw actual piece image
      puzzleCtx.drawImage(
        p.imgElement,
        p.currentX,
        p.currentY,
        puzzleData.pieceWidth,
        puzzleData.pieceHeight
      );
      puzzleCtx.restore();
    }
  });

  // 5. Draw active Particles
  particles.forEach(pt => {
    puzzleCtx.save();
    puzzleCtx.globalAlpha = pt.alpha;
    puzzleCtx.shadowBlur = pt.size * 2;
    puzzleCtx.shadowColor = pt.color;
    puzzleCtx.fillStyle = pt.color;
    puzzleCtx.beginPath();
    puzzleCtx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    puzzleCtx.fill();
    puzzleCtx.restore();
  });
}

// Helper to pre-load image slices into HTMLImageElements for performance
function preCachePieceImages(pieces) {
  pieces.forEach(p => {
    const img = new Image();
    img.src = p.imageUrl;
    p.imgElement = img;
  });
}

// 5. SOLVED CELEBRATION
function triggerPuzzleCompletion({ leaderboard, totalPieces }) {
  currentState = SCREEN_STATE.COMPLETE;
  Sound.playComplete();

  // Calculate solving time
  const endTime = new Date();
  const durationSec = Math.round((endTime - startTime) / 1000);

  // Transition views — must add 'active' to bring opacity from 0 → 1
  document.getElementById('gameplayScreen').classList.remove('active');
  document.getElementById('gameplayScreen').classList.add('hidden');
  document.getElementById('completionScreen').classList.remove('hidden');
  document.getElementById('completionScreen').classList.add('active');

  // Fill stats
  document.getElementById('totalSlicesPlaced').textContent = totalPieces;
  document.getElementById('solvedDuration').textContent = `${durationSec} seconds`;

  // Render leaderboard list
  const list = document.getElementById('leaderboardList');
  list.innerHTML = '';
  
  leaderboard.forEach((player, index) => {
    const item = document.createElement('div');
    item.className = `leaderboard-item ${index === 0 ? 'first-place' : ''}`;
    
    const rankPrefix = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    
    item.innerHTML = `
      <div class="rank-name">
        <span class="rank">${rankPrefix}</span>
        <span class="pdot" style="background: ${player.color}"></span>
        <span class="name">${player.displayName.toUpperCase()}</span>
      </div>
      <div class="score">${player.score} PTS</div>
    `;
    list.appendChild(item);
  });

  // Spawn dynamic rain of completion particles (confetti)
  // Store the interval ID so it can be cancelled on the next game start.
  confettiInterval = setInterval(() => {
    if (currentState === SCREEN_STATE.COMPLETE) {
      const rx = Math.random() * puzzleCanvas.width;
      const ry = Math.random() * puzzleCanvas.height * 0.4;
      spawnSparks(rx, ry, '#FFB100', 8);
      spawnSparks(rx, ry, '#FF5A2C', 8);
    }
  }, 400);
}

// ---- WORD CLOUD SCREEN ----
let wcLatestState = null;
let wcLastResponseId = null;
let wcColorMode = 'classic'; // 'classic' | 'sentiment'
const WC_PALETTE = ['#FF5A2C', '#6C4CE0', '#1B9E57', '#2E73E8', '#FFB100'];
const WC_SENTIMENT_COLORS = { positive: '#1B9E57', negative: '#FF5A2C', neutral: '#2E73E8' };

function startWordCloud(state) {
  currentState = SCREEN_STATE.WORDCLOUD;
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('hidden');
  const panel = document.getElementById('wordcloudScreen');
  panel.classList.remove('hidden');
  panel.classList.add('active');

  document.getElementById('wcRoomCode').textContent = roomCode;
  document.getElementById('wcScreenPrompt').textContent = state.prompt || '';
  const lobbyQr = document.getElementById('qrcode');
  if (lobbyQr) document.getElementById('wcQr').innerHTML = lobbyQr.innerHTML;
  document.getElementById('wcJoinUrl').textContent = document.getElementById('joinUrlVal').textContent;
  renderWordCloud(state);
}

function renderWordCloud(state) {
  wcLatestState = state;
  animateCount(document.getElementById('wcResponseCount'), state.totalResponses || 0);
  animateCount(document.getElementById('wcParticipantCount'), state.uniqueParticipants || 0);
  if (state.prompt) document.getElementById('wcScreenPrompt').textContent = state.prompt;

  const cloud = document.getElementById('wcCloud');
  const words = state.cloud || [];
  // Note: cloud.innerHTML is rewritten below, which removes any #wcEmpty child,
  // so the empty state is re-rendered inline rather than relying on a stored node.
  if (words.length === 0) {
    cloud.innerHTML = '<div class="wc-empty" id="wcEmpty">Waiting for the first response…</div>';
    updateSentimentBar([]);
    return;
  }

  const maxW = words[0].weight, minW = words[words.length - 1].weight;
  const MIN_PX = 22, MAX_PX = 96;
  cloud.innerHTML = '';
  words.forEach((entry, i) => {
    const ratio = maxW === minW ? 1 : (entry.weight - minW) / (maxW - minW);
    const size = Math.round(MIN_PX + ratio * (MAX_PX - MIN_PX));
    const color = wcColorMode === 'sentiment'
      ? (WC_SENTIMENT_COLORS[entry.sentiment] || WC_SENTIMENT_COLORS.neutral)
      : WC_PALETTE[i % WC_PALETTE.length];
    const span = document.createElement('span');
    span.className = 'wc-word';
    span.style.fontSize = `${size}px`;
    span.style.color = color;
    span.title = `${entry.count}x | ${entry.votes} upvotes | ${entry.sentiment}`;
    span.append(entry.word);
    if (entry.votes > 0) {
      const badge = document.createElement('sup');
      badge.className = 'wc-vote-badge';
      badge.textContent = `▲${entry.votes}`;
      span.appendChild(badge);
    }
    cloud.appendChild(span);
  });
  updateSentimentBar(words);

  const responses = state.responses || [];
  const latest = responses[responses.length - 1];
  if (latest && latest.id !== wcLastResponseId) {
    wcLastResponseId = latest.id;
    const ticker = document.getElementById('wcTicker');
    ticker.textContent = `${latest.displayName}: "${latest.text}"`;
    ticker.classList.add('pulse');
    setTimeout(() => ticker.classList.remove('pulse'), 400);
  }
}

function animateCount(el, target) {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (from === target) { el.textContent = target; return; }
  const steps = 12; let i = 0;
  clearInterval(el._countTimer);
  el._countTimer = setInterval(() => {
    i++;
    el.textContent = Math.round(from + (target - from) * (i / steps));
    if (i >= steps) { el.textContent = target; clearInterval(el._countTimer); }
  }, 25);
}

function toggleWordCloudMode() {
  wcColorMode = wcColorMode === 'classic' ? 'sentiment' : 'classic';
  document.getElementById('wcModeBtn').textContent = `Mode: ${wcColorMode === 'sentiment' ? 'Sentiment' : 'Classic'}`;
  document.getElementById('wcSentimentBar').classList.toggle('hidden', wcColorMode !== 'sentiment');
  if (wcLatestState) renderWordCloud(wcLatestState);
}

function updateSentimentBar(words) {
  if (wcColorMode !== 'sentiment') return;
  const totals = { positive: 0, neutral: 0, negative: 0 };
  words.forEach(w => { totals[w.sentiment] = (totals[w.sentiment] || 0) + w.weight; });
  const sum = totals.positive + totals.neutral + totals.negative || 1;
  const set = (id, val) => {
    const seg = document.getElementById(id);
    const pct = Math.round((val / sum) * 100);
    seg.style.width = `${pct}%`;
    seg.querySelector('span').textContent = pct >= 8 ? `${pct}%` : '';
  };
  set('wcSegPos', totals.positive);
  set('wcSegNeu', totals.neutral);
  set('wcSegNeg', totals.negative);
}

function showWordCloudSummary(summary) {
  currentState = SCREEN_STATE.COMPLETE;
  Sound.playComplete();
  const panel = document.getElementById('wordcloudScreen');
  panel.classList.remove('active');
  panel.classList.add('hidden');
  const sum = document.getElementById('wordcloudSummaryScreen');
  sum.classList.remove('hidden');
  sum.classList.add('active');

  document.getElementById('wcSummaryPrompt').textContent = summary.prompt || '';
  document.getElementById('wcSummaryResponses').textContent = summary.totalResponses || 0;
  document.getElementById('wcSummaryPeople').textContent = summary.uniqueParticipants || 0;
  document.getElementById('wcSummaryVotes').textContent = summary.totalVotes || 0;

  const list = document.getElementById('wcSummaryList');
  list.innerHTML = '';
  (summary.topWords || []).forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = `leaderboard-item ${index === 0 ? 'first-place' : ''}`;
    const rank = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    const votes = entry.votes > 0 ? ` · ▲${entry.votes}` : '';
    item.innerHTML = `<div class="rank-name"><span class="rank">${rank}</span><span class="name">${entry.word}</span></div><div class="score">${entry.count}x${votes}</div>`;
    list.appendChild(item);
  });

  if (confettiInterval !== null) clearInterval(confettiInterval);
  confettiInterval = setInterval(() => {
    if (currentState === SCREEN_STATE.COMPLETE) {
      const rx = Math.random() * puzzleCanvas.width;
      const ry = Math.random() * puzzleCanvas.height * 0.4;
      spawnSparks(rx, ry, '#1B9E57', 8);
      spawnSparks(rx, ry, '#2E73E8', 8);
    }
  }, 400);
}

function exportWordCloudCsv() {
  if (!wcLatestState) return;
  const rows = [['response', 'name', 'submitted_at']];
  (wcLatestState.responses || []).forEach(r => rows.push([r.text, r.displayName, r.createdAt]));
  const csv = rows.map(cols => cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `wordcloud-${roomCode}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Main Frame tick
function gameLoop() {
  updateStars();
  drawBackground();

  if (currentState === SCREEN_STATE.PLAYING) {
    updateJigsaw();
    drawJigsaw();
  }

  animationFrameId = requestAnimationFrame(gameLoop);
}

// Resizing handler
function handleResize() {
  if (bgCanvas) {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    initStars();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  bgCanvas = document.getElementById('bgCanvas');
  bgCtx = bgCanvas.getContext('2d');

  puzzleCanvas = document.getElementById('puzzleCanvas');
  puzzleCtx = puzzleCanvas.getContext('2d');

  window.addEventListener('resize', handleResize);
  handleResize();

  const exportBtn = document.getElementById('wcExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportWordCloudCsv);
  const summaryExportBtn = document.getElementById('wcSummaryExportBtn');
  if (summaryExportBtn) summaryExportBtn.addEventListener('click', exportWordCloudCsv);
  const modeBtn = document.getElementById('wcModeBtn');
  if (modeBtn) modeBtn.addEventListener('click', toggleWordCloudMode);

  setupConnection();

  // Run screen rendering thread
  gameLoop();
});
