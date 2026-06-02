document.addEventListener('DOMContentLoaded', () => {
  let socket = null;
  let roomCode = '';
  let myPlayerId = '';
  let myColor = '';
  let myDisplayName = '';
  let piecesPlacedCount = 0;
  let currentAssignedPieces = [];
  let selectedPieceIndex = 0;
  let currentActivityType = null; // 'jigsaw' | 'wordcloud'

  // Workspace configuration
  const CANVAS_WIDTH = 1200;
  const CANVAS_HEIGHT = 800;
  let puzzleRows = 4;
  let puzzleCols = 6;

  // DOM Elements
  const joinSection = document.getElementById('joinSection');
  const waitingSection = document.getElementById('waitingSection');
  const gameplaySection = document.getElementById('gameplaySection');
  const completeSection = document.getElementById('completeSection');

  const joinForm = document.getElementById('joinForm');
  const displayNameInput = document.getElementById('displayNameInput');
  const joinRoomCode = document.getElementById('joinRoomCode');
  
  const welcomeText = document.getElementById('welcomeText');
  const playerColorVal = document.getElementById('playerColorVal');

  const headerPilotName = document.getElementById('headerPilotName');
  const headerColorDot = document.getElementById('headerColorDot');
  const gameProgressPct = document.getElementById('gameProgressPct');
  const assignedPiecesPool = document.getElementById('assignedPiecesPool');
  const dragBoard = document.getElementById('dragBoard');
  const pieceSelectorContainer = document.getElementById('pieceSelectorContainer');

  const myContributionsVal = document.getElementById('myContributionsVal');

  // Extract roomCode from URL (/join/ABCD)
  const pathParts = window.location.pathname.split('/');
  roomCode = pathParts[pathParts.length - 1].toUpperCase();
  joinRoomCode.textContent = roomCode;

  // Peek: press and hold to reveal the full picture behind the grid
  const peekBtn = document.getElementById('peekBtn');
  if (peekBtn) {
    const startPeek = (e) => { e.preventDefault(); dragBoard.classList.add('peeking'); peekBtn.classList.add('held'); };
    const endPeek = () => { dragBoard.classList.remove('peeking'); peekBtn.classList.remove('held'); };
    peekBtn.addEventListener('pointerdown', startPeek);
    peekBtn.addEventListener('pointerup', endPeek);
    peekBtn.addEventListener('pointerleave', endPeek);
    peekBtn.addEventListener('pointercancel', endPeek);
  }

  // 1. JOIN FORM FORM SUBMISSION
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myDisplayName = displayNameInput.value.trim();
    if (!myDisplayName) return;

    initializeSocketConnection();
  });

  // 2. SOCKET AND PAIRING MANAGEMENT
  function initializeSocketConnection() {
    socket = io();

    socket.on('connect', () => {
      // Send join message
      socket.emit('join-room', { roomCode, displayName: myDisplayName });
    });

    socket.on('joined-successfully', (data) => {
      myPlayerId = data.playerId;
      myColor = data.color;
      
      // Update UI
      welcomeText.textContent = `WELCOME, ${myDisplayName.toUpperCase()}`;
      playerColorVal.textContent = getNeonColorName(myColor);
      playerColorVal.style.color = myColor;
      
      joinSection.classList.add('hidden');
      waitingSection.classList.remove('hidden');
    });

    socket.on('room-update', (data) => {
      // Only the jigsaw board is driven by room-update; the word cloud manages
      // its own screen via activity-start (room-update is broadcast room-wide).
      if (data.status === 'active' && currentActivityType !== 'wordcloud') {
        waitingSection.classList.add('hidden');
        gameplaySection.classList.remove('hidden');
      }
    });

    socket.on('activity-start', (data) => {
      currentActivityType = data.type;

      // Word Cloud mode uses its own submission screen; jigsaw uses the board.
      if (data.type === 'wordcloud') {
        startWordCloud(data.state);
        return;
      }

      waitingSection.classList.add('hidden');
      completeSection.classList.add('hidden');
      gameplaySection.classList.remove('hidden');

      // Initialise header details
      headerPilotName.textContent = myDisplayName.toUpperCase();
      headerColorDot.style.backgroundColor = myColor;
      headerColorDot.style.boxShadow = `0 0 8px ${myColor}`;
      
      gameProgressPct.textContent = `${data.state.progress}%`;
      currentAssignedPieces = data.state.assignedPieces || [];
      selectedPieceIndex = 0;
      
      // Set background image on dragBoard as a ghost reference
      if (data.state.imageUrl) {
        dragBoard.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.65)), url(${data.state.imageUrl})`;
        dragBoard.style.backgroundSize = '100% 100%';
        dragBoard.style.backgroundPosition = 'center';
        const peekLayer = document.getElementById('peekLayer');
        if (peekLayer) peekLayer.src = data.state.imageUrl;
      }

      // Configure grid overlay to match server rows/cols
      const gridOverlay = document.getElementById('gridOverlay');
      if (gridOverlay && data.state.rows && data.state.cols) {
        puzzleRows = data.state.rows;
        puzzleCols = data.state.cols;
        gridOverlay.style.gridTemplateColumns = `repeat(${puzzleCols}, 1fr)`;
        gridOverlay.style.gridTemplateRows = `repeat(${puzzleRows}, 1fr)`;
        gridOverlay.innerHTML = '';
        const totalCells = puzzleRows * puzzleCols;
        for (let i = 0; i < totalCells; i++) {
          gridOverlay.appendChild(document.createElement('div'));
        }
      }

      renderAssignedPieces();
    });

    socket.on('assign-pieces', (data) => {
      currentAssignedPieces = data.assignedPieces || [];
      selectedPieceIndex = Math.max(0, Math.min(selectedPieceIndex, currentAssignedPieces.length - 1));
      renderAssignedPieces();
    });

    socket.on('piece-placed', (data) => {
      gameProgressPct.textContent = `${data.progress}%`;
      // Check if this was solved by me
      if (data.placedBy.toLowerCase() === myDisplayName.toLowerCase()) {
        piecesPlacedCount++;
        triggerHapticFeedback(true);
      }
    });

    socket.on('placement-incorrect', (data) => {
      triggerHapticFeedback(false);
      // Find matching piece and run shake animation
      const el = document.getElementById(data.pieceId);
      if (el) {
        el.classList.add('shake');
        setTimeout(() => el.classList.remove('shake'), 500);
      }
    });

    socket.on('activity-complete', () => {
      gameplaySection.classList.add('hidden');
      completeSection.classList.remove('hidden');
      myContributionsVal.textContent = piecesPlacedCount;
    });

    socket.on('response-accepted', (data) => {
      onResponseAccepted(data);
    });

    socket.on('wordcloud-update', (state) => {
      if (currentActivityType === 'wordcloud') renderVoteChips(state.cloud || []);
    });

    socket.on('wordcloud-closed', () => {
      wordcloudSection.classList.add('hidden');
      document.getElementById('wordcloudClosedSection').classList.remove('hidden');
    });

    socket.on('host-disconnected', () => {
      if (window.crowdOverlay) {
        window.crowdOverlay('Screen disconnected', 'The big screen went offline. Tap below to rejoin the game.', 'Back to start', function(){ window.location.reload(); });
      } else { alert('Event Big Screen disconnected. Returning to entry screen.'); window.location.reload(); }
    });

    socket.on('error-message', (msg) => {
      if (window.crowdOverlay) {
        window.crowdOverlay('Something went wrong', msg, 'Back to start', function(){ window.location.reload(); });
      } else { alert(msg); window.location.reload(); }
    });
  }

  // 3. PIECE RENDERER & TOUCH DRAGGING ENGINE
  function renderAssignedPieces() {
    assignedPiecesPool.innerHTML = '';
    pieceSelectorContainer.innerHTML = '';

    // Guard against undefined/null (shouldn't happen but defensive)
    if (!currentAssignedPieces || currentAssignedPieces.length === 0) {
      assignedPiecesPool.innerHTML = '<div class="minimap-hint" style="color: var(--color-cyan)">Waiting for piece assignment...</div>';
      return;
    }

    // Ensure selectedPieceIndex is in valid range
    selectedPieceIndex = Math.max(0, Math.min(selectedPieceIndex, currentAssignedPieces.length - 1));

    // Show the active piece — centered in the drag board.
    // Player drags it to its correct grid position.
    const p = currentAssignedPieces[selectedPieceIndex];

    const el = document.createElement('div');
    el.className = 'draggable-piece';
    el.id = p.id;
    // Set dynamic dimensions to exactly match the grid cell size
    const percentWidth = 100 / puzzleCols;
    const percentHeight = 100 / puzzleRows;
    el.style.width = `${percentWidth}%`;
    el.style.height = `${percentHeight}%`;
    
    // Position at the bottom initially, centered horizontally
    el.style.left = '50%';
    el.style.top = '75%';
    el.innerHTML = `<img src="${p.imageUrl}" alt="Puzzle Piece" draggable="false" />`;

    assignedPiecesPool.appendChild(el);
    setupDragging(el, p);

    // Show a hint label indicating the grid target (row, col) for this piece
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;bottom:6px;left:0;right:0;text-align:center;font-size:11px;color:rgba(0,243,255,0.5);font-family:monospace;pointer-events:none;';
    hint.textContent = `Target: row ${p.row + 1}, col ${p.col + 1}`;
    assignedPiecesPool.appendChild(hint);

    // Render selector tabs if there are multiple pieces
    if (currentAssignedPieces.length > 1) {
      currentAssignedPieces.forEach((piece, idx) => {
        const tab = document.createElement('div');
        tab.className = `piece-tab ${idx === selectedPieceIndex ? 'active' : ''}`;
        
        tab.innerHTML = `
          <div class="piece-tab-thumb">
            <img src="${piece.imageUrl}" alt="Piece Thumbnail" draggable="false" />
          </div>
          <div class="piece-tab-info">
            <span class="tab-title">Piece ${idx + 1}</span>
            <span class="tab-target">Row ${piece.row + 1}, Col ${piece.col + 1}</span>
          </div>
        `;
        
        tab.addEventListener('click', () => {
          if (selectedPieceIndex !== idx) {
            selectedPieceIndex = idx;
            renderAssignedPieces();
          }
        });
        
        pieceSelectorContainer.appendChild(tab);
      });
    }
  }

  function setupDragging(element, pieceInfo) {
    let active = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;
    let xOffset = 0;
    let yOffset = 0;

    // Attach only pointerdown to the element.
    // pointermove/pointerup are added to document only while dragging
    // and removed immediately on release — prevents listener accumulation.
    element.addEventListener('pointerdown', dragStart);

    function dragStart(e) {
      e.preventDefault();
      active = true;
      element.classList.add('dragging');

      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      // Add move/up listeners only for the duration of this drag
      document.addEventListener('pointermove', drag, { passive: false });
      document.addEventListener('pointerup', dragEnd);
    }

    function drag(e) {
      if (!active) return;
      e.preventDefault();

      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      xOffset = currentX;
      yOffset = currentY;

      element.style.transform = `translate(calc(-50% + ${currentX}px), calc(-50% + ${currentY}px)) scale(1.1)`;

      // Map touch position to the 1200×800 server canvas coordinate space
      const rect = dragBoard.getBoundingClientRect();
      const touchX = e.clientX - rect.left;
      const touchY = e.clientY - rect.top;

      // Snap to the nearest grid cell to remove guesswork
      const cellWidth = rect.width / puzzleCols;
      const cellHeight = rect.height / puzzleRows;
      
      const targetCol = Math.max(0, Math.min(puzzleCols - 1, Math.floor(touchX / cellWidth)));
      const targetRow = Math.max(0, Math.min(puzzleRows - 1, Math.floor(touchY / cellHeight)));

      const canvasX = Math.round(targetCol * (CANVAS_WIDTH / puzzleCols));
      const canvasY = Math.round(targetRow * (CANVAS_HEIGHT / puzzleRows));

      // Emit live position so big screen can show the drag in real time
      socket.emit('move-piece', {
        pieceId: pieceInfo.id,
        currentX: canvasX,
        currentY: canvasY
      });

      // Highlight the grid cell the piece is currently hovering over
      const go = document.getElementById('gridOverlay');
      if (go && go.children.length) {
        const idx = targetRow * puzzleCols + targetCol;
        for (let i = 0; i < go.children.length; i++) {
          go.children[i].classList.toggle('cell-hot', i === idx);
        }
      }
    }

    function dragEnd(e) {
      if (!active) return;
      active = false;
      element.classList.remove('dragging');

      // Always remove the document-level listeners immediately
      document.removeEventListener('pointermove', drag);
      document.removeEventListener('pointerup', dragEnd);

      const rect = dragBoard.getBoundingClientRect();
      const touchX = e.clientX - rect.left;
      const touchY = e.clientY - rect.top;

      const cellWidth = rect.width / puzzleCols;
      const cellHeight = rect.height / puzzleRows;

      const targetCol = Math.max(0, Math.min(puzzleCols - 1, Math.floor(touchX / cellWidth)));
      const targetRow = Math.max(0, Math.min(puzzleRows - 1, Math.floor(touchY / cellHeight)));

      const canvasX = Math.round(targetCol * (CANVAS_WIDTH / puzzleCols));
      const canvasY = Math.round(targetRow * (CANVAS_HEIGHT / puzzleRows));

      // Final placement submission
      socket.emit('place-piece', {
        pieceId: pieceInfo.id,
        currentX: canvasX,
        currentY: canvasY
      });

      // Reset visual position — server will confirm or deny placement
      xOffset = 0;
      yOffset = 0;
      element.style.transform = `translate(-50%, -50%)`;

      // Clear the cell highlight
      const go = document.getElementById('gridOverlay');
      if (go) { for (let i = 0; i < go.children.length; i++) go.children[i].classList.remove('cell-hot'); }
    }
  }

  // Helper colors
  function getNeonColorName(hex) {
    const colors = {
      '#ff007f': 'NEON PINK',
      '#00f3ff': 'NEON CYAN',
      '#ffb800': 'NEON GOLD',
      '#39ff14': 'NEON GRASS',
      '#9d00ff': 'NEON AMETHYST',
      '#ff4500': 'NEON RED',
      '#e0b0ff': 'NEON MAUVE',
      '#ff00ff': 'NEON MAGENTA'
    };
    return colors[hex] || 'NEON PILOT';
  }

  // 4. HAPTICS (Device Vibration)
  // ---- WORD CLOUD SUBMISSION + VOTING ----
  const wordcloudSection = document.getElementById('wordcloudSection');
  const wordcloudForm = document.getElementById('wordcloudForm');
  const wcInput = document.getElementById('wcInput');
  const wcPrompt = document.getElementById('wcPrompt');
  const wcCharCount = document.getElementById('wcCharCount');
  const wcRemaining = document.getElementById('wcRemaining');
  const wcSubmitBtn = document.getElementById('wcSubmitBtn');
  const wcConfirm = document.getElementById('wcConfirm');
  const wcConfirmText = document.getElementById('wcConfirmText');
  const wcDone = document.getElementById('wcDone');
  const wcVoteArea = document.getElementById('wcVoteArea');
  const wcVoteChips = document.getElementById('wcVoteChips');
  const wcVotedWords = new Set();

  let wcMaxChars = 80;
  let wcRemainingCount = 3;

  function startWordCloud(state) {
    joinSection.classList.add('hidden');
    waitingSection.classList.add('hidden');
    gameplaySection.classList.add('hidden');
    completeSection.classList.add('hidden');
    wordcloudSection.classList.remove('hidden');

    wcMaxChars = state.maxChars || 80;
    wcRemainingCount = (state.remaining != null) ? state.remaining : (state.maxSubmissions || 3);
    wcPrompt.textContent = state.prompt || '';
    wcInput.maxLength = wcMaxChars;
    updateCharCount();
    updateRemaining();
    if (wcRemainingCount <= 0) showAllSubmitted();
  }

  function updateCharCount() { wcCharCount.textContent = `${wcInput.value.length} / ${wcMaxChars}`; }
  function updateRemaining() { wcRemaining.textContent = `${wcRemainingCount} left`; }
  function showAllSubmitted() {
    wordcloudForm.classList.add('hidden');
    wcConfirm.classList.add('hidden');
    wcDone.classList.remove('hidden');
  }

  function onResponseAccepted(data) {
    wcRemainingCount = data.remaining;
    updateRemaining();
    wcSubmitBtn.disabled = false;
    wcSubmitBtn.textContent = 'Send to Screen';
    wcInput.value = '';
    updateCharCount();
    wcConfirmText.textContent = data.hidden
      ? 'Received — hidden by the profanity filter.'
      : "Response sent! It's on the big screen.";
    wcConfirm.classList.remove('hidden');
    if (wcRemainingCount <= 0) setTimeout(showAllSubmitted, 1200);
  }

  // Render the top words as tappable upvote chips.
  function renderVoteChips(cloud) {
    const top = cloud.slice(0, 12);
    if (top.length === 0) { wcVoteArea.classList.add('hidden'); return; }
    wcVoteArea.classList.remove('hidden');
    wcVoteChips.innerHTML = '';
    top.forEach((entry) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wc-chip';
      const voted = wcVotedWords.has(entry.word);
      if (voted) chip.classList.add('voted');
      chip.disabled = voted;
      chip.innerHTML = `<span>${entry.word}</span><span class="wc-chip-votes">▲${entry.votes}</span>`;
      chip.addEventListener('click', () => {
        if (wcVotedWords.has(entry.word) || !socket) return;
        wcVotedWords.add(entry.word);
        chip.classList.add('voted');
        chip.disabled = true;
        socket.emit('vote-word', { word: entry.word });
      });
      wcVoteChips.appendChild(chip);
    });
  }

  if (wcInput) wcInput.addEventListener('input', updateCharCount);
  if (wordcloudForm) {
    wordcloudForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = wcInput.value.trim();
      if (!text || !socket) return;
      wcSubmitBtn.disabled = true;
      wcSubmitBtn.textContent = 'Sending…';
      socket.emit('submit-response', { text });
    });
  }

  function triggerHapticFeedback(success) {
    if ('vibrate' in navigator) {
      if (success) {
        // Success haptic: short double tap
        navigator.vibrate([40, 40, 60]);
      } else {
        // Failure haptic: long single rumble
        navigator.vibrate(200);
      }
    }
  }
});
