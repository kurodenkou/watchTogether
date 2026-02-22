/* ══════════════════════════════════════════════════════
   WatchTogether – client-side application

   Flow:
   1. User joins a room via the join screen
   2. App requests webcam + mic via getUserMedia
   3. Socket connects and emits 'join-room'
   4. Server sends back room-state (existing users + video state + operators)
   5. For each existing user, we initiate a WebRTC offer
   6. When new users join after us, they initiate offers to us
   7. HLS video is loaded via hls.js; play/pause/seek events
      are broadcast to the room and applied on all peers
   8. Operator role: the first joiner (or a randomly-selected participant
      when the last operator leaves) controls video playback and URL.
      Operators can promote any participant to operator via right-click.
════════════════════════════════════════════════════════ */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const joinScreen        = document.getElementById('join-screen');
const appScreen         = document.getElementById('app-screen');
const inputName         = document.getElementById('input-name');
const inputRoom         = document.getElementById('input-room');
const btnGenRoom        = document.getElementById('btn-gen-room');
const btnJoin           = document.getElementById('btn-join');
const joinError         = document.getElementById('join-error');
const displayRoomId     = document.getElementById('display-room-id');
const btnCopyRoom       = document.getElementById('btn-copy-room');
const btnToggleMic      = document.getElementById('btn-toggle-mic');
const btnToggleCam      = document.getElementById('btn-toggle-cam');
const btnLeave          = document.getElementById('btn-leave');
const inputHlsUrl       = document.getElementById('input-hls-url');
const btnLoadUrl        = document.getElementById('btn-load-url');
const mainVideo         = document.getElementById('main-video');
const videoPlaceholder  = document.getElementById('video-placeholder');
const syncIndicator     = document.getElementById('sync-indicator');
const videoBlocker      = document.getElementById('video-controls-blocker');
const participantsGrid  = document.getElementById('participants-grid');
const participantCount  = document.getElementById('participant-count');
const toastContainer    = document.getElementById('toast-container');
const tmplParticipant   = document.getElementById('tmpl-participant');
const contextMenu       = document.getElementById('participant-context-menu');
const ctxMakeOperator   = document.getElementById('ctx-make-operator');

// ── State ─────────────────────────────────────────────────────────────────────
let socket          = null;
let localStream     = null;
let myId            = null;
let myName          = '';
let roomId          = '';
let hlsInstance     = null;
let isMicOn         = true;
let isCamOn         = true;
let isSyncing       = false;       // suppress loopback when applying remote sync
let syncHideTimer   = null;

// Operator state
let operators       = new Set();   // set of socket IDs that are operators
let isOperator      = false;       // whether the local user is an operator

// peerConnections[socketId] = RTCPeerConnection
const peerConnections = {};

// ICE servers – using public STUN (Google)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function randomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function showToast(msg, duration = 3000) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = msg;
  toastContainer.appendChild(div);
  setTimeout(() => {
    div.classList.add('fade-out');
    div.addEventListener('animationend', () => div.remove());
  }, duration);
}

function showError(msg) {
  joinError.textContent = msg;
  joinError.classList.remove('hidden');
}

function updateParticipantCount() {
  const count = participantsGrid.querySelectorAll('.participant-tile').length;
  participantCount.textContent = count;
}

function showSyncIndicator() {
  syncIndicator.classList.remove('hidden');
  clearTimeout(syncHideTimer);
  syncHideTimer = setTimeout(() => syncIndicator.classList.add('hidden'), 1800);
}

// ── Operator UI helpers ───────────────────────────────────────────────────────

// Enable/disable URL bar and video controls based on operator status.
function updateOperatorUI() {
  inputHlsUrl.disabled = !isOperator;
  btnLoadUrl.disabled  = !isOperator;

  updateVideoBlocker();

  // Refresh my own tile badge
  if (myId) {
    const myTile = getTile(myId);
    if (myTile) updateTileOperatorBadge(myTile, myId);
  }
}

// Show the blocker overlay only while a non-operator's video is playing.
// When the video is paused (e.g. autoplay blocked on iOS, or initial load)
// the blocker is hidden so the user can press the native play button.
// Once playing, the blocker is restored to prevent seeking and pausing.
function updateVideoBlocker() {
  if (!videoBlocker) return;
  videoBlocker.classList.toggle('hidden', isOperator || mainVideo.paused);
}

// Update the star badge on every tile in the grid.
function updateAllOperatorBadges() {
  participantsGrid.querySelectorAll('.participant-tile').forEach(tile => {
    updateTileOperatorBadge(tile, tile.dataset.peerId);
  });
}

// Add or remove the operator star badge from a single tile.
function updateTileOperatorBadge(tile, peerId) {
  const badgesEl = tile.querySelector('.participant-badges');
  if (!badgesEl) return;

  const existing = badgesEl.querySelector('.badge-operator');
  if (operators.has(peerId)) {
    if (!existing) {
      const badge = document.createElement('span');
      badge.className = 'badge-operator';
      badge.title = 'Operator – controls video playback';
      badge.textContent = '\u2605'; // ★
      badgesEl.appendChild(badge);
    }
  } else {
    if (existing) existing.remove();
  }
}

// Apply a fresh operators list received from the server.
function applyOperators(opList) {
  const wasOperator = isOperator;
  operators = new Set(opList);
  isOperator = operators.has(myId);

  if (!wasOperator && isOperator) {
    showToast('You are now an operator. You control video playback.');
  }

  updateOperatorUI();
  updateAllOperatorBadges();
}

// ── Join screen logic ─────────────────────────────────────────────────────────
btnGenRoom.addEventListener('click', () => {
  inputRoom.value = randomRoomId();
});

btnJoin.addEventListener('click', startSession);
inputName.addEventListener('keydown', e => e.key === 'Enter' && startSession());
inputRoom.addEventListener('keydown', e => e.key === 'Enter' && startSession());

async function startSession() {
  const name = inputName.value.trim();
  const room = inputRoom.value.trim();

  if (!name) { showError('Please enter your name.'); return; }
  if (!room)  { showError('Please enter or generate a room ID.'); return; }

  joinError.classList.add('hidden');
  btnJoin.disabled = true;
  btnJoin.textContent = 'Connecting…';

  // Request media – fall back to audio-only if camera is unavailable
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      showToast('Camera unavailable – joining with audio only.');
    } catch (err2) {
      // Graceful degradation – continue without any media
      console.warn('getUserMedia failed:', err2);
      showToast('Camera/mic unavailable – joining without media.');
      localStream = null;
    }
  }

  myName = name;
  roomId = room;

  connectSocket();
}

// ── Socket.io connection ──────────────────────────────────────────────────────
function connectSocket() {
  socket = io();
  myId   = null;

  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join-room', { roomId, name: myName });
  });

  socket.on('room-state', ({ users, operators: opList, videoState }) => {
    // Switch to app screen
    joinScreen.classList.remove('active');
    appScreen.classList.add('active');
    displayRoomId.textContent = roomId;
    btnJoin.disabled = false;
    btnJoin.textContent = 'Join Room';

    // Apply operator list before rendering tiles so badges appear immediately
    operators  = new Set(opList);
    isOperator = operators.has(myId);
    updateOperatorUI();

    // Add my own tile first, then assign the stream after it's in the DOM
    // (mirrors how remote tiles receive their stream via pc.ontrack)
    addParticipantTile(myId, myName, null, true);
    const localTile = getTile(myId);
    if (localTile && localStream) {
      const videoEl = localTile.querySelector('video');
      videoEl.srcObject = localStream;
      videoEl.play().catch(() => {});
      updateNoVideoOverlay(localTile, localStream);
    }
    if (localTile) updateTileOperatorBadge(localTile, myId);

    // Connect to existing users (we initiate offers)
    for (const user of users) {
      if (user.id !== myId) {
        addParticipantTile(user.id, user.name, null, false);
        createPeerConnection(user.id, true);
      }
    }

    // Apply existing video state
    if (videoState.url) {
      inputHlsUrl.value = videoState.url;
      loadHls(videoState.url, videoState);
    }
  });

  socket.on('user-joined', ({ user, operators: opList }) => {
    if (user.id === myId) return;
    showToast(`${user.name} joined`);
    addParticipantTile(user.id, user.name, null, false);
    // New user will send us an offer; we just wait
    createPeerConnection(user.id, false);
    // Refresh operator list (the new joiner is never an operator on arrival,
    // but this keeps the list authoritative)
    applyOperators(opList);
  });

  socket.on('user-left', ({ userId }) => {
    const tile = getTile(userId);
    const name = tile ? tile.querySelector('.participant-name').textContent : 'Someone';
    removePeer(userId);
    showToast(`${name} left`);
    // operators-changed may follow separately if an operator left
  });

  // Server broadcasts updated operator list (e.g. after assign or auto-promote)
  socket.on('operators-changed', ({ operators: opList }) => {
    applyOperators(opList);
  });

  // ── WebRTC signaling ──────────────────────────────────────────────────────
  socket.on('rtc-offer', async ({ fromId, offer }) => {
    let pc = peerConnections[fromId];
    if (!pc) pc = createPeerConnection(fromId, false);

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('rtc-answer', { targetId: fromId, answer });
  });

  socket.on('rtc-answer', async ({ fromId, answer }) => {
    const pc = peerConnections[fromId];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('rtc-ice-candidate', ({ fromId, candidate }) => {
    const pc = peerConnections[fromId];
    if (pc && candidate) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  });

  // ── Video sync ────────────────────────────────────────────────────────────
  socket.on('video-sync', ({ action, currentTime, url }) => {
    handleRemoteSync(action, currentTime, url);
  });

  socket.on('disconnect', () => {
    showToast('Disconnected from server.');
  });
}

// ── WebRTC peer connections ───────────────────────────────────────────────────
function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[peerId] = pc;

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // Receive remote tracks
  pc.ontrack = (event) => {
    const tile = getTile(peerId);
    if (!tile) return;
    const videoEl = tile.querySelector('video');
    if (videoEl.srcObject !== event.streams[0]) {
      videoEl.srcObject = event.streams[0];
      videoEl.muted = false; // template sets muted for autoplay; unmute for remote peers
      videoEl.play().catch(() => {});
      updateNoVideoOverlay(tile, event.streams[0]);
    }
  };

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('rtc-ice-candidate', { targetId: peerId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      console.warn(`[rtc] connection to ${peerId} ${pc.connectionState}`);
    }
  };

  // If we're the initiator, create and send an offer
  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc-offer', { targetId: peerId, offer: pc.localDescription });
      } catch (err) {
        console.error('[rtc] offer error', err);
      }
    };
  }

  return pc;
}

function removePeer(peerId) {
  const pc = peerConnections[peerId];
  if (pc) { pc.close(); delete peerConnections[peerId]; }

  const tile = getTile(peerId);
  if (tile) tile.remove();
  updateParticipantCount();
}

// ── Participant tiles ─────────────────────────────────────────────────────────
function addParticipantTile(id, name, stream, isLocal) {
  if (getTile(id)) return; // already exists

  const frag = tmplParticipant.content.cloneNode(true);
  const tile  = frag.querySelector('.participant-tile');
  tile.dataset.peerId = id;

  const videoEl = tile.querySelector('video');
  const nameEl  = tile.querySelector('.participant-name');
  const initEl  = tile.querySelector('.avatar-initial');
  const overlay = tile.querySelector('.no-video-overlay');

  nameEl.textContent  = isLocal ? `${name} (you)` : name;
  initEl.textContent  = name[0] || '?';

  if (isLocal) {
    videoEl.muted = true; // prevent feedback
    overlay.classList.add('visible');
    tile.dataset.local = 'true';
  } else {
    overlay.classList.add('visible'); // show until stream arrives
  }

  // Apply operator badge before appending so it's immediately visible
  const badgesEl = tile.querySelector('.participant-badges');
  if (badgesEl && operators.has(id)) {
    const badge = document.createElement('span');
    badge.className = 'badge-operator';
    badge.title = 'Operator – controls video playback';
    badge.textContent = '\u2605';
    badgesEl.appendChild(badge);
  }

  participantsGrid.appendChild(frag);

  // iOS Safari: play() must be called after the element is in the DOM
  if (isLocal && stream) {
    videoEl.play().catch(() => {});
  }

  updateParticipantCount();
}

function getTile(peerId) {
  return participantsGrid.querySelector(`[data-peer-id="${peerId}"]`);
}

function updateNoVideoOverlay(tile, stream) {
  const overlay  = tile.querySelector('.no-video-overlay');
  const hasVideo = stream && stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
  if (hasVideo) {
    overlay.classList.remove('visible');
  } else {
    overlay.classList.add('visible');
  }
}

// ── Context menu – operator promotes a participant ────────────────────────────
let contextMenuTargetId = null;

// Show context menu on right-click inside participants grid (only for operators)
participantsGrid.addEventListener('contextmenu', (e) => {
  const tile = e.target.closest('.participant-tile');
  if (!tile) return;
  if (!isOperator) return; // only operators see the menu

  const peerId = tile.dataset.peerId;
  if (!peerId || peerId === myId) return; // can't act on self
  if (operators.has(peerId)) return;      // already an operator

  e.preventDefault();
  contextMenuTargetId = peerId;

  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top  = `${e.clientY}px`;
  contextMenu.classList.remove('hidden');
});

// Make Operator button in context menu
ctxMakeOperator.addEventListener('click', () => {
  if (contextMenuTargetId && socket) {
    socket.emit('assign-operator', { roomId, targetId: contextMenuTargetId });
  }
  hideContextMenu();
});

// Close context menu on any outside click
document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

function hideContextMenu() {
  contextMenu.classList.add('hidden');
  contextMenuTargetId = null;
}

// ── Mic / Camera toggles ──────────────────────────────────────────────────────
btnToggleMic.addEventListener('click', () => {
  if (!localStream) return;
  isMicOn = !isMicOn;
  localStream.getAudioTracks().forEach(t => { t.enabled = isMicOn; });
  btnToggleMic.classList.toggle('muted', !isMicOn);
  btnToggleMic.title = isMicOn ? 'Mute microphone' : 'Unmute microphone';
});

btnToggleCam.addEventListener('click', () => {
  if (!localStream) return;
  isCamOn = !isCamOn;
  localStream.getVideoTracks().forEach(t => { t.enabled = isCamOn; });
  btnToggleCam.classList.toggle('muted', !isCamOn);
  btnToggleCam.title = isCamOn ? 'Turn off camera' : 'Turn on camera';

  // Refresh overlay on local tile
  const myTile = getTile(myId);
  if (myTile) updateNoVideoOverlay(myTile, localStream);
});

// ── Leave room ────────────────────────────────────────────────────────────────
btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  if (socket) { socket.disconnect(); socket = null; }
  Object.keys(peerConnections).forEach(id => {
    peerConnections[id].close();
    delete peerConnections[id];
  });
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  mainVideo.style.display = 'none';
  mainVideo.srcObject = null;
  mainVideo.src       = '';
  videoPlaceholder.classList.remove('hidden');
  participantsGrid.innerHTML = '';
  updateParticipantCount();

  // Reset operator state
  operators  = new Set();
  isOperator = false;
  inputHlsUrl.disabled = false;
  btnLoadUrl.disabled  = false;
  if (videoBlocker) videoBlocker.classList.add('hidden');

  appScreen.classList.remove('active');
  joinScreen.classList.add('active');
  inputHlsUrl.value = '';
}

// ── Copy room link ────────────────────────────────────────────────────────────
btnCopyRoom.addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  navigator.clipboard.writeText(url).then(() => showToast('Room link copied!'));
});

// Pre-fill room from URL param
(function() {
  const params = new URLSearchParams(location.search);
  if (params.get('room')) inputRoom.value = params.get('room');
})();

// ── Video loading ─────────────────────────────────────────────────────────────
btnLoadUrl.addEventListener('click', () => {
  if (!isOperator) return; // redundant guard; button is disabled for non-operators
  const url = inputHlsUrl.value.trim();
  if (!url) return;
  loadVideo(url, null);
  // Broadcast URL to room
  socket && socket.emit('video-sync', { roomId, action: 'set-url', url });
});

inputHlsUrl.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnLoadUrl.click();
});

function isMp4Url(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith('.mp4') || path.endsWith('.m4v');
  } catch (_) {
    return url.toLowerCase().includes('.mp4');
  }
}

function loadVideo(url, initialState) {
  // Tear down old HLS instance if any
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  mainVideo.src       = '';
  mainVideo.style.display = 'block';
  videoPlaceholder.classList.add('hidden');

  function applyInitialState() {
    if (initialState) {
      mainVideo.currentTime = initialState.currentTime || 0;
      if (initialState.playing) {
        mainVideo.play().catch(err => {
          // iOS Safari blocks autoplay without a direct user gesture; tell the user
          if (err.name === 'NotAllowedError') {
            showToast('Tap the video to start playback.');
          }
        });
      }
    }
  }

  if (isMp4Url(url)) {
    // Native MP4 playback – no library needed
    mainVideo.src = url;
    mainVideo.addEventListener('loadedmetadata', applyInitialState, { once: true });
  } else if (Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hlsInstance = hls;
    hls.loadSource(url);
    hls.attachMedia(mainVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, applyInitialState);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) showToast('HLS error: ' + data.details);
    });
  } else if (mainVideo.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari)
    mainVideo.src = url;
    mainVideo.addEventListener('loadedmetadata', applyInitialState, { once: true });
  } else {
    showToast('Your browser does not support HLS playback.');
    return;
  }

  // Bind sync events (once per load)
  attachVideoSyncListeners();
  // Video is paused at load time; update blocker state so non-operators
  // can press play immediately without waiting for a play/pause event.
  updateVideoBlocker();
}

// Keep backward-compatible alias used by room-state handler
function loadHls(url, initialState) { loadVideo(url, initialState); }

// ── Video sync: outgoing ──────────────────────────────────────────────────────
let syncDebounceTimer = null;

function attachVideoSyncListeners() {
  // Only operators broadcast sync events; participants receive them.
  mainVideo.onplay  = () => {
    updateVideoBlocker(); // restore blocker for non-operators once playing
    if (isSyncing || !isOperator) return;
    socket && socket.emit('video-sync', {
      roomId,
      action: 'play',
      currentTime: mainVideo.currentTime
    });
  };

  mainVideo.onpause = () => {
    updateVideoBlocker(); // reveal controls so non-operators can press play again
    if (isSyncing || !isOperator) return;
    socket && socket.emit('video-sync', {
      roomId,
      action: 'pause',
      currentTime: mainVideo.currentTime
    });
  };

  mainVideo.onseeked = () => {
    if (isSyncing || !isOperator) return;
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      socket && socket.emit('video-sync', {
        roomId,
        action: 'seek',
        currentTime: mainVideo.currentTime
      });
    }, 300);
  };
}

// ── Video sync: incoming ──────────────────────────────────────────────────────
function handleRemoteSync(action, currentTime, url) {
  showSyncIndicator();

  if (action === 'set-url') {
    inputHlsUrl.value = url;
    loadHls(url, null);
    return;
  }

  isSyncing = true;

  if (action === 'seek' && typeof currentTime === 'number') {
    const drift = Math.abs(mainVideo.currentTime - currentTime);
    if (drift > 1) mainVideo.currentTime = currentTime;
  }

  if (action === 'play') {
    if (typeof currentTime === 'number') {
      const drift = Math.abs(mainVideo.currentTime - currentTime);
      if (drift > 1) mainVideo.currentTime = currentTime;
    }
    mainVideo.play().catch(err => {
      // iOS Safari blocks autoplay without a direct user gesture; tell the user
      if (err.name === 'NotAllowedError') {
        showToast('Tap the video to start playback.');
      }
    }).finally(() => { isSyncing = false; });
    return;
  }

  if (action === 'pause') {
    mainVideo.pause();
  }

  // Small delay before re-enabling outgoing sync to avoid echo
  setTimeout(() => { isSyncing = false; }, 500);
}
