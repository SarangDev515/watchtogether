const $ = (id) => document.getElementById(id);
const state = {
  ws: null, me: null, name: '', role: '', roomId: '', peers: new Map(),
  localStream: null, screenStream: null, screenSenders: new Map(), maxGuests: 2,
  playback: { src: '', isPlaying: false, currentTime: 0, updatedAt: 0 },
  applyingPlayback: false,
};

const configuredBackend = String(window.WATCHTOGETHER_BACKEND_URL || 'https://watchtogether-backend-6d7x.onrender.com').trim().replace(/\/$/, '');
function backendHttpUrl(path = '') { return `${configuredBackend}${path}` || path; }
function backendWebSocketUrl() {
  const base = configuredBackend || location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}

function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2800); }
function beginRoomEntry(status) { $('entry-status').textContent = status; $('entry-intro').classList.remove('hidden'); return new Promise((resolve) => setTimeout(resolve, 5000)); }
function endRoomEntry() { $('entry-intro').classList.add('hidden'); }
function showRoomFull(message) { $('room-full-message').textContent = message || 'This room has reached the guest limit set by the host.'; $('room-full-modal').classList.remove('hidden'); }
$('close-room-full').addEventListener('click', () => $('room-full-modal').classList.add('hidden'));
function send(payload) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload)); }
function sendPlayback(action, extra = {}) { if (state.role === 'host') send({ type: 'playback-control', action, currentTime: $('movie-video').currentTime || 0, ...extra }); }
function roomUrl() { return `${location.origin}${location.pathname}?room=${state.roomId}`; }
function setRoomVisible(visible) { $('landing').classList.toggle('hidden', visible); $('room').classList.toggle('hidden', !visible); }
function setRoomTitle() { const current = state.peers.size + 1; const total = state.maxGuests + 1; $('room-title-text').textContent = `${state.roomId} · ${current}/${total} people`; $('member-count').textContent = `${current}/${total} people`; }
function addChat(from, text, system = false) { const box = $('chat-messages'); if (system && box.querySelector('.system-message')) box.innerHTML = ''; const item = document.createElement('div'); item.className = system ? 'system-message' : 'message'; if (system) item.textContent = text; else item.innerHTML = `<div class="message-meta"></div><div class="message-body"></div>`; if (!system) { item.querySelector('.message-meta').textContent = from; item.querySelector('.message-body').textContent = text; } box.appendChild(item); box.scrollTop = box.scrollHeight; }
function updateEmptyState() { $('empty-state').classList.toggle('hidden', state.peers.size > 0 || !!state.localStream || !!state.screenStream || !!state.playback.src); }
function formatTime(value) { if (!Number.isFinite(value)) return '0:00'; const seconds = Math.max(0, Math.floor(value)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function updateMovieProgress() { const video = $('movie-video'); const duration = Number.isFinite(video.duration) ? video.duration : 0; $('movie-seek').max = duration || 100; $('movie-seek').value = Math.min(video.currentTime || 0, duration || 100); $('movie-time').textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`; $('movie-play').textContent = video.paused ? '▶ Play' : 'Ⅱ Pause'; }
function updatePlaybackRole() { const host = state.role === 'host'; $('movie-url').disabled = !host; $('load-movie').disabled = !host; $('movie-play').disabled = !host; $('movie-seek').disabled = !host; $('movie-role-note').textContent = host ? 'Host controls are synchronized for everyone in the room.' : 'The host controls playback for everyone.'; $('movie-video').controls = host; }

function connect() {
  state.ws = new WebSocket(backendWebSocketUrl());
  state.ws.onopen = () => { if (state.joinMode === 'create') send({ type: 'create-room', name: state.name, maxGuests: state.maxGuests }); else send({ type: 'join-room', name: state.name, roomId: state.roomId }); };
  state.ws.onmessage = ({ data }) => handleMessage(JSON.parse(data));
  state.ws.onclose = () => { if (!$('room').classList.contains('hidden')) toast('Connection closed. Refresh to start again.'); };
  state.ws.onerror = () => toast('Could not connect to the local server.');
}

function handleMessage(message) {
  if (message.type === 'welcome') return state.me = message.peerId;
  if (message.type === 'error') { endRoomEntry(); if (message.code === 'ROOM_FULL') return showRoomFull(message.message); return toast(message.message); }
  if (message.type === 'room-created' || message.type === 'room-joined') {
    endRoomEntry();
    state.roomId = message.roomId; state.role = message.role; state.me = message.peerId; state.maxGuests = Number(message.maxGuests) || 2; state.peers.clear();
    if (message.playback) applyPlayback(message.playback);
    if (message.peers) message.peers.forEach((peer) => { state.peers.set(peer.id, { ...peer, pc: null, streams: new Map() }); createPeerConnection(peer.id, peer.name, false); });
    setRoomVisible(true); setRoomTitle(); $('host-note').classList.toggle('hidden', state.role !== 'host'); $('movie-panel').classList.remove('hidden'); updatePlaybackRole(); updateEmptyState();
    history.replaceState({}, '', `?room=${state.roomId}`); addChat('', state.role === 'host' ? 'Room created. Invite your friends with the link.' : 'You joined the room.', true);
    return;
  }
  if (message.type === 'peer-joined') { const peer = message.peer; state.peers.set(peer.id, { ...peer, pc: null, streams: new Map() }); createPeerConnection(peer.id, peer.name, true); setRoomTitle(); addChat('', `${peer.name} joined the room.`, true); updateEmptyState(); return; }
  if (message.type === 'peer-left') { const peer = state.peers.get(message.peerId); if (peer) { peer.pc?.close(); state.peers.delete(message.peerId); document.querySelectorAll(`[data-peer="${message.peerId}"]`).forEach((el) => el.remove()); addChat('', `${peer.name} left the room.`, true); setRoomTitle(); updateEmptyState(); } return; }
  if (message.type === 'playback-state') return applyPlayback(message.playback);
  if (message.type === 'signal') handleSignal(message);
  if (message.type === 'chat') addChat(message.from, message.text);
}

function applyPlayback(playback) {
  if (!playback?.src) return;
  state.playback = { ...state.playback, ...playback };
  const video = $('movie-video'); const src = state.playback.src;
  const targetTime = Math.max(0, Number(state.playback.currentTime) || 0) + (state.playback.isPlaying ? Math.max(0, (Date.now() - Number(state.playback.updatedAt || Date.now())) / 1000) : 0);
  const sync = () => {
    state.applyingPlayback = true;
    try { if (Number.isFinite(video.duration)) video.currentTime = Math.min(targetTime, video.duration); else video.currentTime = targetTime; } catch {}
    updateMovieProgress();
    if (state.playback.isPlaying) video.play().catch(() => toast('Tap Play to start the synchronized movie.')); else video.pause();
    setTimeout(() => { state.applyingPlayback = false; }, 500);
  };
  $('movie-panel').classList.remove('hidden'); $('movie-url').value = src; updateEmptyState();
  const absoluteSrc = new URL(src, location.href).href;
  if (video.src !== absoluteSrc) { video.addEventListener('loadedmetadata', sync, { once: true }); video.src = src; video.load(); } else sync();
}

function createPeerConnection(peerId, peerName, initiator) {
  if (state.peers.get(peerId)?.pc) return state.peers.get(peerId).pc;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const peer = state.peers.get(peerId) || { id: peerId, name: peerName, streams: new Map() }; peer.pc = pc; peer.name = peerName; state.peers.set(peerId, peer);
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'signal', to: peerId, data: { candidate } }); };
  pc.ontrack = ({ track, streams }) => { const stream = streams[0]; if (!stream) return; peer.streams.set(stream.id, stream); renderRemoteStream(peerId, peerName, stream); track.onended = () => { document.querySelector(`[data-stream="${stream.id}"]`)?.remove(); }; };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) { pc.close(); peer.pc = null; } };
  if (state.localStream) state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
  if (state.screenStream) state.screenStream.getTracks().forEach((track) => { const sender = pc.addTrack(track, state.screenStream); state.screenSenders.set(`${peerId}:${track.id}`, sender); });
  if (initiator) pc.onnegotiationneeded = async () => { try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); send({ type: 'signal', to: peerId, data: { description: pc.localDescription } }); } catch (error) { console.warn(error); } };
  return pc;
}

async function handleSignal(message) {
  const peer = state.peers.get(message.from); if (!peer) state.peers.set(message.from, { id: message.from, name: message.fromName || 'Guest', pc: null, streams: new Map() });
  const pc = createPeerConnection(message.from, message.fromName || 'Guest', false); const data = message.data;
  try { if (data.description) { await pc.setRemoteDescription(data.description); if (data.description.type === 'offer') { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); send({ type: 'signal', to: message.from, data: { description: pc.localDescription } }); } } else if (data.candidate) await pc.addIceCandidate(data.candidate); } catch (error) { console.warn('WebRTC signal error', error); }
}

function renderRemoteStream(peerId, peerName, stream) { const id = `remote-${peerId}-${stream.id}`; if ($(id)) return; const card = document.createElement('div'); card.className = 'video-card'; card.id = id; card.dataset.peer = peerId; card.dataset.stream = stream.id; const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.srcObject = stream; const label = document.createElement('div'); label.className = 'video-label'; label.textContent = peerName; card.append(video, label); $('video-grid').appendChild(card); updateEmptyState(); }
function renderLocalVideo(stream, labelText, cardId) { let card = $(cardId); if (!card) { card = document.createElement('div'); card.className = 'video-card self-card'; card.id = cardId; const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; const label = document.createElement('div'); label.className = 'video-label'; label.textContent = labelText; card.append(video, label); $('video-grid').appendChild(card); } card.querySelector('video').srcObject = stream; }

async function enableMedia() { if (state.localStream) return state.localStream; try { state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); renderLocalVideo(state.localStream, `${state.name} (you)`, 'local-card'); state.localStream.getTracks().forEach((track) => state.peers.forEach(({ pc }) => pc?.addTrack(track, state.localStream))); $('mic-btn').classList.add('active'); $('camera-btn').classList.add('active'); updateEmptyState(); toast('Microphone and camera enabled'); return state.localStream; } catch { toast('Camera or microphone permission was not granted.'); return null; } }
async function toggleMic() { const stream = await enableMedia(); if (!stream) return; const track = stream.getAudioTracks()[0]; track.enabled = !track.enabled; $('mic-btn').classList.toggle('off', !track.enabled); $('mic-btn').innerHTML = `${track.enabled ? '⌕' : '×'} <span>${track.enabled ? 'Mic' : 'Muted'}</span>`; }
async function toggleCamera() { const stream = await enableMedia(); if (!stream) return; const track = stream.getVideoTracks()[0]; track.enabled = !track.enabled; $('camera-btn').classList.toggle('off', !track.enabled); $('camera-btn').innerHTML = `${track.enabled ? '▣' : '×'} <span>${track.enabled ? 'Camera' : 'Camera off'}</span>`; }
async function toggleScreen() { if (state.role !== 'host') return toast('Only the host can share the movie screen.'); if (state.screenStream) return stopScreen(); try { state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); renderLocalVideo(state.screenStream, 'Your shared screen', 'screen-card'); state.peers.forEach(({ pc }, peerId) => state.screenStream.getTracks().forEach((track) => { const sender = pc?.addTrack(track, state.screenStream); if (sender) state.screenSenders.set(`${peerId}:${track.id}`, sender); })); $('screen-btn').classList.add('active'); $('screen-btn').innerHTML = '■ <span>Stop sharing</span>'; state.screenStream.getVideoTracks()[0].onended = stopScreen; updateEmptyState(); toast('Screen sharing started'); } catch { toast('Screen sharing was cancelled.'); } }
function stopScreen() { if (!state.screenStream) return; const trackIds = new Set(state.screenStream.getTracks().map((track) => track.id)); state.screenStream.getTracks().forEach((track) => track.stop()); state.screenSenders.forEach((sender, key) => { if (key.split(':').some((part) => trackIds.has(part))) { try { sender?.replaceTrack(null); } catch {} } }); state.screenSenders.clear(); state.screenStream = null; $('screen-card')?.remove(); $('screen-btn').classList.remove('active'); $('screen-btn').innerHTML = '▤ <span>Share screen</span>'; updateEmptyState(); toast('Screen sharing stopped'); }

$('movie-video').addEventListener('loadedmetadata', updateMovieProgress);
$('movie-video').addEventListener('error', () => { if ($('movie-video').src) toast('This browser cannot play this MKV or its codec. Try MP4/WebM or use screen sharing.'); });
$('movie-video').addEventListener('timeupdate', updateMovieProgress);
$('movie-video').addEventListener('play', () => { updateMovieProgress(); if (state.role === 'host' && !state.applyingPlayback) sendPlayback('play'); });
$('movie-video').addEventListener('pause', () => { updateMovieProgress(); if (state.role === 'host' && !state.applyingPlayback) sendPlayback('pause'); });
$('movie-video').addEventListener('seeking', () => { updateMovieProgress(); if (state.role === 'host' && !state.applyingPlayback) sendPlayback('seek'); });
$('movie-play').addEventListener('click', () => { if (state.role !== 'host') return; const video = $('movie-video'); if (!video.src) return toast('Load a movie URL first.'); video.paused ? video.play().catch(() => toast('The browser blocked playback. Press Play again.')) : video.pause(); });
$('movie-seek').addEventListener('input', () => { if (state.role !== 'host') return; const video = $('movie-video'); video.currentTime = Number($('movie-seek').value); updateMovieProgress(); });
$('load-movie').addEventListener('click', () => { const src = $('movie-url').value.trim(); if (!src) return toast('Paste a public video URL first.'); try { new URL(src); } catch { return toast('Enter a valid video URL.'); } sendPlayback('load', { src }); });
function updateUploadProgress(percent, status) { $('upload-progress').classList.remove('hidden'); $('upload-bar').value = percent; $('upload-percent').textContent = `${Math.round(percent)}%`; $('upload-status').textContent = status; }
function hideUploadProgress() { setTimeout(() => $('upload-progress').classList.add('hidden'), 900); }
function uploadVideoWithProgress(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', backendHttpUrl('/upload-video')); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); xhr.setRequestHeader('X-File-Name', file.name);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) updateUploadProgress((event.loaded / event.total) * 100, `Uploading ${file.name}…`); };
    xhr.onload = () => { let result; try { result = JSON.parse(xhr.responseText); } catch { return reject(new Error('The server returned an invalid upload response.')); } if (xhr.status >= 200 && xhr.status < 300) resolve(result); else reject(new Error(result.error || 'Upload failed.')); };
    xhr.onerror = () => reject(new Error('Video upload failed. Check the local server connection.'));
    xhr.send(file);
  });
}
$('movie-file').addEventListener('change', async (event) => {
  if (state.role !== 'host') return toast('Only the host can load a video file.');
  const file = event.target.files?.[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024 * 1024) { event.target.value = ''; return toast('Choose a video smaller than 5 GB.'); }
  const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  const allowedExtensions = ['.mp4', '.webm', '.ogg', '.mkv'];
  if (!file.type.startsWith('video/') && !allowedExtensions.includes(fileExtension)) { event.target.value = ''; return toast('Choose an MP4, WebM, OGG, or MKV video file.'); }
  const picker = document.querySelector('.file-picker'); const previous = picker.textContent; picker.textContent = 'Uploading…'; picker.style.pointerEvents = 'none'; updateUploadProgress(0, `Preparing ${file.name}…`);
  try {
    const result = await uploadVideoWithProgress(file); updateUploadProgress(100, 'Upload complete');
    const src = new URL(result.url, configuredBackend || location.origin).href; $('movie-url').value = src; sendPlayback('load', { src }); toast('Video uploaded and ready for the room'); hideUploadProgress();
  } catch (error) { updateUploadProgress(0, 'Upload failed'); toast(error.message || 'Video upload failed.'); hideUploadProgress(); }
  finally { picker.textContent = previous; picker.style.pointerEvents = ''; event.target.value = ''; }
});

document.querySelectorAll('[data-guests]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-guests]').forEach((item) => item.classList.remove('selected')); button.classList.add('selected'); $('guest-limit').value = button.dataset.guests; }));
$('create-form').addEventListener('submit', async (event) => { event.preventDefault(); state.joinMode = 'create'; state.name = $('create-name').value.trim(); state.maxGuests = Math.min(10, Math.max(1, Number($('guest-limit').value) || 2)); if (state.name) { await beginRoomEntry('Creating your private room…'); connect(); } });
$('join-form').addEventListener('submit', async (event) => { event.preventDefault(); state.joinMode = 'join'; state.name = $('join-name').value.trim(); state.roomId = $('room-code').value.trim().toUpperCase(); if (state.name && state.roomId) { await beginRoomEntry('Joining the room…'); connect(); } });
$('mic-btn').addEventListener('click', toggleMic); $('camera-btn').addEventListener('click', toggleCamera); $('screen-btn').addEventListener('click', toggleScreen);
$('copy-link').addEventListener('click', async () => { await navigator.clipboard.writeText(roomUrl()); toast('Invite link copied'); });
$('leave-room').addEventListener('click', () => location.href = location.pathname);
$('chat-toggle').addEventListener('click', () => $('chat-panel').classList.add('open')); $('chat-close').addEventListener('click', () => $('chat-panel').classList.remove('open'));
$('chat-form').addEventListener('submit', (event) => { event.preventDefault(); const input = $('chat-input'); const text = input.value.trim(); if (text) { send({ type: 'chat', text }); addChat('You', text); input.value = ''; } });
const initialRoom = new URLSearchParams(location.search).get('room'); if (initialRoom) $('room-code').value = initialRoom.toUpperCase();
