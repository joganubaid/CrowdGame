document.addEventListener('DOMContentLoaded', () => {
  let socket = null;
  let authToken = null;
  let activeRoomCode = null;
  let uploadedImageUrl = null;

  // DOM Elements
  const loginSection = document.getElementById('loginSection');
  const controlSection = document.getElementById('controlSection');
  const loginForm = document.getElementById('loginForm');
  const adminPassword = document.getElementById('adminPassword');
  const loginError = document.getElementById('loginError');

  const setupForm = document.getElementById('setupForm');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const gridRows = document.getElementById('gridRows');
  const gridCols = document.getElementById('gridCols');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('puzzleImageFile');
  const uploadStatus = document.getElementById('uploadStatus');
  const imagePreviewContainer = document.getElementById('imagePreviewContainer');
  const imagePreview = document.getElementById('imagePreview');
  const clearImageBtn = document.getElementById('clearImageBtn');
  const createRoomBtn = document.getElementById('createRoomBtn');

  const consolePlaceholder = document.getElementById('consolePlaceholder');
  const consoleActive = document.getElementById('consoleActive');
  const activeRoomCodeDisp = document.getElementById('activeRoomCode');
  const activeRoomStatusDisp = document.getElementById('activeRoomStatus');
  const qrCodeWrapper = document.getElementById('qrCodeWrapper');
  const activeJoinUrl = document.getElementById('activeJoinUrl');
  const copyUrlBtn = document.getElementById('copyUrlBtn');
  const attendeesCount = document.getElementById('attendeesCount');
  const puzzleProgress = document.getElementById('puzzleProgress');
  const startActivityBtn = document.getElementById('startActivityBtn');
  const resetRoomBtn = document.getElementById('resetRoomBtn');
  const consoleLog = document.getElementById('consoleLog');

  // Word cloud controls
  const activityType = document.getElementById('activityType');
  const jigsawConfig = document.getElementById('jigsawConfig');
  const wordcloudConfig = document.getElementById('wordcloudConfig');
  const wcPromptInput = document.getElementById('wcPromptInput');
  const wcResponseFormat = document.getElementById('wcResponseFormat');
  const wcMaxSubmissions = document.getElementById('wcMaxSubmissions');
  const closeWordcloudBtn = document.getElementById('closeWordcloudBtn');
  const moderationPanel = document.getElementById('moderationPanel');
  const moderationList = document.getElementById('moderationList');
  const progressMetricLabel = document.getElementById('progressMetricLabel');

  // Toggle config block to match selected mode.
  function syncActivityConfigVisibility() {
    const isWordCloud = activityType.value === 'wordcloud';
    wordcloudConfig.classList.toggle('hidden', !isWordCloud);
    jigsawConfig.classList.toggle('hidden', isWordCloud);
  }
  activityType.addEventListener('change', syncActivityConfigVisibility);
  syncActivityConfigVisibility();

  // Render the live moderation list; each row can be hidden from the cloud.
  function renderModerationList(responses) {
    if (!responses.length) {
      moderationList.innerHTML = '<span class="moderation-empty">No responses yet.</span>';
      return;
    }
    moderationList.innerHTML = '';
    responses.slice().reverse().forEach((r) => {
      const row = document.createElement('div');
      row.className = 'moderation-row';
      const text = document.createElement('span');
      text.className = 'moderation-text';
      text.textContent = r.text;
      text.title = `by ${r.displayName}`;
      const btn = document.createElement('button');
      btn.className = 'moderation-remove';
      btn.textContent = '✕';
      btn.setAttribute('aria-label', `Hide response: ${r.text}`);
      btn.addEventListener('click', () => {
        socket.emit('admin-remove-response', { roomCode: activeRoomCode, responseId: r.id });
      });
      row.appendChild(text);
      row.appendChild(btn);
      moderationList.appendChild(row);
    });
  }

  // Helper to log console messages
  function consoleLogMsg(msg) {
    const time = new Date().toLocaleTimeString();
    consoleLog.innerHTML += `\n[${time}] ${msg}`;
    consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  // 1. ADMIN AUTHENTICATION
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword.value })
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        authToken = data.token;
        loginSection.classList.add('hidden');
        controlSection.classList.remove('hidden');
        initializeSocket();
      } else {
        loginError.textContent = data.error || 'Authentication failed.';
        loginError.classList.remove('hidden');
      }
    } catch (err) {
      console.error('Login error:', err);
      loginError.textContent = 'Network error connecting to authentication service.';
      loginError.classList.remove('hidden');
    }
  });

  // 2. SOCKET INITIALIZATION
  function initializeSocket() {
    // Supply the JWT in the handshake auth so the server middleware can mark
    // this socket as isAdmin = true before any events are processed.
    socket = io({ auth: { token: authToken } });
    
    socket.on('connect', () => {
      console.log('Admin socket connected.');
    });

    socket.on('player-joined', (data) => {
      consoleLogMsg(`Player '${data.displayName}' connected.`);
      attendeesCount.textContent = data.count;
    });

    socket.on('player-left', (data) => {
      consoleLogMsg(`Player '${data.displayName}' disconnected.`);
      attendeesCount.textContent = data.count;
    });

    socket.on('piece-placed', (data) => {
      if (data.correct) {
        consoleLogMsg(`Piece solved by ${data.placedBy}! Progress: ${data.progress}%`);
        puzzleProgress.textContent = `${data.progress}%`;
      }
    });

    socket.on('activity-complete', (data) => {
      consoleLogMsg(`🏆 PUZZLE SOLVED COMPLETED!`);
      activeRoomStatusDisp.textContent = 'COMPLETED';
      activeRoomStatusDisp.className = 'value status-badge completed';
    });

    socket.on('error-message', (msg) => {
      consoleLogMsg(`[ERROR] ${msg}`);
      if (window.crowdOverlay) { window.crowdOverlay('Something went wrong', msg); } else { alert(msg); }
    });

    // Word Cloud: refresh live count + moderation list.
    socket.on('wordcloud-update', (state) => {
      puzzleProgress.textContent = state.totalResponses;
      renderModerationList(state.responses || []);
    });
  }

  // 3. FILE UPLOAD HANDLING (DRAG & DROP)
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#00f3ff';
    dropzone.style.background = 'rgba(0, 243, 255, 0.08)';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'rgba(0, 243, 255, 0.3)';
    dropzone.style.background = 'rgba(0, 243, 255, 0.02)';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'rgba(0, 243, 255, 0.3)';
    dropzone.style.background = 'rgba(0, 243, 255, 0.02)';
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  async function handleFileUpload(file) {
    if (!file.type.startsWith('image/')) {
      alert('File must be an image type (PNG, JPEG, GIF).');
      return;
    }
    
    uploadStatus.classList.remove('hidden');
    dropzone.classList.add('hidden');
    
    const formData = new FormData();
    formData.append('image', file);
    
    try {
      const response = await fetch('/api/admin/upload-puzzle-image', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`
        },
        body: formData
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        uploadedImageUrl = data.imageUrl;
        imagePreview.src = uploadedImageUrl;
        imagePreviewContainer.classList.remove('hidden');
      } else {
        alert(data.error || 'Image upload failed.');
        dropzone.classList.remove('hidden');
      }
    } catch (err) {
      console.error('Upload error:', err);
      alert('Error uploading file to storage server.');
      dropzone.classList.remove('hidden');
    } finally {
      uploadStatus.classList.add('hidden');
    }
  }

  clearImageBtn.addEventListener('click', () => {
    uploadedImageUrl = null;
    fileInput.value = '';
    imagePreviewContainer.classList.add('hidden');
    dropzone.classList.remove('hidden');
  });

  // 4. ROOM CREATION & MANAGEMENT
  setupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    createRoomBtn.disabled = true;
    createRoomBtn.textContent = 'Initializing...';

    const customCode = roomCodeInput.value.trim().toUpperCase();
    
    try {
      // Create room code parameters via room api
      const urlParams = customCode ? `?roomCode=${customCode}` : '';
      const response = await fetch(`/api/room/config${urlParams}`);
      const roomConfig = await response.json();

      activeRoomCode = roomConfig.roomCode;
      activeRoomCodeDisp.textContent = activeRoomCode;

      // Pre-create the room in the server's RoomManager so that Start Activity
      // works immediately without waiting for the screen display to connect.
      // When screen.html connects later it will take over as the display host.
      socket.emit('host-room', activeRoomCode);

      // Update QR Code image
      qrCodeWrapper.innerHTML = `<img src="${roomConfig.qrDataUrl}" alt="Join QR Code" />`;
      activeJoinUrl.textContent = roomConfig.joinUrl;

      // Unhide panels
      consolePlaceholder.classList.add('hidden');
      consoleActive.classList.remove('hidden');
      
      consoleLogMsg(`Event initialized. Waiting for screen display / screen/${activeRoomCode} connection...`);
      
      // Prompt user to open the Big Screen display
      const hostLink = `${window.location.protocol}//${window.location.host}/screen/${activeRoomCode}`;
      consoleLogMsg(`👉 PLEASE OPEN SCREEN DISPLAY AT: ${hostLink}`);
      
      createRoomBtn.textContent = 'Room Active';
    } catch (err) {
      console.error('Room creation failed:', err);
      alert('Failed to initialize event room.');
      createRoomBtn.disabled = false;
      createRoomBtn.textContent = 'Initialize Screen Room';
    }
  });

  // Map word-cloud response-format to a character limit.
  const WC_CHAR_LIMITS = { '1word': 20, 'phrase': 80, 'sentence': 280 };

  // Start the selected activity!
  startActivityBtn.addEventListener('click', () => {
    if (!activeRoomCode || !socket) return;

    if (activityType.value === 'wordcloud') {
      const prompt = wcPromptInput.value.trim() || 'Describe today in one word';
      const maxChars = WC_CHAR_LIMITS[wcResponseFormat.value] || 80;
      const maxSubmissions = parseInt(wcMaxSubmissions.value) || 3;

      socket.emit('admin-start-activity', {
        roomCode: activeRoomCode,
        activityType: 'wordcloud',
        prompt, maxChars, maxSubmissions
      });

      consoleLogMsg(`Word Cloud triggered — prompt: "${prompt}" (${maxChars} chars, ${maxSubmissions}/person).`);
      progressMetricLabel.textContent = 'Responses';
      puzzleProgress.textContent = '0';
      moderationPanel.classList.remove('hidden');
      closeWordcloudBtn.classList.remove('hidden');
    } else {
      const rows = parseInt(gridRows.value) || 4;
      const cols = parseInt(gridCols.value) || 6;

      socket.emit('admin-start-activity', {
        roomCode: activeRoomCode,
        activityType: 'jigsaw',
        rows, cols,
        imageUrl: uploadedImageUrl // Null = default server-generated image
      });

      consoleLogMsg(`Activity jigsaw triggered (grid: ${rows}x${cols}). Slicing image...`);
    }

    activeRoomStatusDisp.textContent = 'ACTIVE';
    activeRoomStatusDisp.className = 'value status-badge active';
    startActivityBtn.disabled = true;
  });

  // Close the word cloud and reveal the summary on the big screen.
  closeWordcloudBtn.addEventListener('click', () => {
    if (!activeRoomCode || !socket) return;
    if (!confirm('Close the word cloud and show the final results on the big screen?')) return;
    socket.emit('admin-close-activity', { roomCode: activeRoomCode });
    consoleLogMsg('Word Cloud closed — revealing summary on the big screen.');
    activeRoomStatusDisp.textContent = 'COMPLETED';
    activeRoomStatusDisp.className = 'value status-badge completed';
    closeWordcloudBtn.disabled = true;
  });

  // Reset the room session
  resetRoomBtn.addEventListener('click', () => {
    if (!confirm('Are you sure you want to terminate the current room session? This will disconnect all players.')) return;
    window.location.reload();
  });

  // Copy join link to clipboard
  copyUrlBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(activeJoinUrl.textContent)
      .then(() => {
        const prevText = copyUrlBtn.textContent;
        copyUrlBtn.textContent = 'Copied!';
        setTimeout(() => copyUrlBtn.textContent = prevText, 2000);
      })
      .catch(err => console.error('Copy failed:', err));
  });
});
