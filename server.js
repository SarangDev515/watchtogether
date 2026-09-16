const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const rooms = new Map();
const clients = new Map();
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || '*').trim();

function setCorsHeaders(req, res) {
  const requestOrigin = String(req.headers.origin || '').trim();
  const allowedOrigin = FRONTEND_ORIGIN === '*' ? '*' : requestOrigin === FRONTEND_ORIGIN ? FRONTEND_ORIGIN : FRONTEND_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function makeId(size = 8) {
  return crypto.randomBytes(size).toString('hex');
}

function makeRoomCode() {
  let code;
  do code = crypto.randomBytes(3).toString('hex').toUpperCase();
  while (rooms.has(code));
  return code;
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function roomPeers(room, exceptId) {
  return [...room.peers.values()]
    .filter((peer) => peer.id !== exceptId)
    .map(({ id, name, role }) => ({ id, name, role }));
}

function broadcast(room, payload, exceptId) {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptId) send(peer.ws, payload);
  }
}

function cleanupRoomUpload(room) {
  try {
    const pathname = new URL(room.playback.src || '', 'http://localhost').pathname;
    if (!pathname.startsWith('/uploads/')) return;
    const filename = path.basename(pathname);
    fs.rm(path.join(UPLOAD_DIR, filename), { force: true }, () => {});
  } catch {}
}

function removePeer(ws) {
  const peer = clients.get(ws);
  if (!peer) return;
  clients.delete(ws);
  if (!peer.roomId) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;
  room.peers.delete(peer.id);
  broadcast(room, { type: 'peer-left', peerId: peer.id });
  if (room.peers.size === 0) { cleanupRoomUpload(room); rooms.delete(peer.roomId); }
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mkv': 'video/x-matroska' };

function serveFile(req, res, filePath) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stats.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      return fs.createReadStream(filePath).pipe(res);
    }
    if (!range.startsWith('bytes=')) { res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }); return res.end(); }
    const [startText, endText] = range.slice(6).split('-');
    const start = startText ? Number(startText) : Math.max(0, stats.size - Number(endText || 0));
    const end = endText ? Math.min(stats.size - 1, Number(endText)) : stats.size - 1;
    if (start > end || start >= stats.size) { res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stats.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

function uploadVideo(req, res) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Video is larger than 5 GB.' })); }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const requestedName = String(req.headers['x-file-name'] || 'watch-party-video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  let ext = path.extname(requestedName).toLowerCase();
  if (!['.mp4', '.webm', '.ogg', '.mkv'].includes(ext)) ext = contentType === 'video/webm' ? '.webm' : contentType === 'video/x-matroska' ? '.mkv' : '.mp4';
  const storedName = `${makeId(12)}${ext}`;
  const storedPath = path.join(UPLOAD_DIR, storedName);
  const output = fs.createWriteStream(storedPath);
  let bytes = 0; let rejected = false;
  req.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_UPLOAD_BYTES) { rejected = true; req.destroy(); output.destroy(); fs.rm(storedPath, { force: true }, () => {}); } else output.write(chunk); });
  req.on('error', () => { output.destroy(); fs.rm(storedPath, { force: true }, () => {}); });
  req.on('end', () => { if (rejected) return; output.end(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url: `/uploads/${storedName}`, size: bytes })); }); });
}

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const requestedPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'POST' && requestedPath === '/upload-video') return uploadVideo(req, res);
  if (requestedPath.startsWith('/uploads/')) {
    const filePath = path.normalize(path.join(UPLOAD_DIR, requestedPath.replace('/uploads/', '')));
    if (!filePath.startsWith(UPLOAD_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(req, res, filePath);
  }
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.split('/').filter(Boolean).join('/');
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  return serveFile(req, res, filePath);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const peer = { id: makeId(6), name: 'Guest', role: 'guest', roomId: null, ws };
  clients.set(ws, peer);
  send(ws, { type: 'welcome', peerId: peer.id });

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid message.' }); }
    const current = clients.get(ws);
    if (!current) return;

    if (message.type === 'create-room') {
      if (current.roomId) return;
      current.name = String(message.name || 'Host').trim().slice(0, 30) || 'Host';
      current.role = 'host';
      const roomId = makeRoomCode();
      const requestedGuests = Number(message.maxGuests);
      const maxGuests = Number.isFinite(requestedGuests) ? Math.min(10, Math.max(1, Math.floor(requestedGuests))) : 2;
      const room = {
        id: roomId,
        hostId: current.id,
        maxGuests,
        peers: new Map(),
        playback: { src: '', isPlaying: false, currentTime: 0, updatedAt: Date.now() },
      };
      room.peers.set(current.id, current);
      rooms.set(roomId, room);
      current.roomId = roomId;
      return send(ws, { type: 'room-created', roomId, peerId: current.id, name: current.name, role: 'host', maxGuests: room.maxGuests });
    }

    if (message.type === 'join-room') {
      if (current.roomId) return;
      const roomId = String(message.roomId || '').trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return send(ws, { type: 'error', message: 'Room not found. Ask the host for a new link.' });
      if (room.peers.size - 1 >= room.maxGuests) return send(ws, { type: 'error', code: 'ROOM_FULL', message: `This room is full. The host allowed ${room.maxGuests} ${room.maxGuests === 1 ? 'guest' : 'guests'}.` });
      current.name = String(message.name || 'Guest').trim().slice(0, 30) || 'Guest';
      current.role = 'guest';
      current.roomId = roomId;
      room.peers.set(current.id, current);
      send(ws, { type: 'room-joined', roomId, peerId: current.id, name: current.name, role: current.role, hostId: room.hostId, maxGuests: room.maxGuests, peers: roomPeers(room, current.id), playback: room.playback });
      broadcast(room, { type: 'peer-joined', peer: { id: current.id, name: current.name, role: current.role } }, current.id);
      return;
    }

    if (message.type === 'playback-control') {
      const room = current.roomId && rooms.get(current.roomId);
      if (!room) return;
      if (current.id !== room.hostId) return send(ws, { type: 'error', message: 'Only the host can control synchronized playback.' });
      const action = String(message.action || '');
      if (!['load', 'play', 'pause', 'seek'].includes(action)) return;
      if (action === 'load') {
        const src = String(message.src || '').trim();
        if (!(src.startsWith('http://') || src.startsWith('https://'))) return send(ws, { type: 'error', message: 'Use a public HTTP or HTTPS video URL for synchronized playback.' });
        room.playback.src = src;
        room.playback.currentTime = 0;
        room.playback.isPlaying = false;
      } else if (action === 'seek') {
        const time = Number(message.currentTime);
        if (!Number.isFinite(time) || time < 0) return;
        room.playback.currentTime = time;
      } else {
        room.playback.isPlaying = action === 'play';
        if (Number.isFinite(Number(message.currentTime)) && Number(message.currentTime) >= 0) room.playback.currentTime = Number(message.currentTime);
      }
      room.playback.updatedAt = Date.now();
      return broadcast(room, { type: 'playback-state', playback: { ...room.playback } });
    }

    if (message.type === 'signal') {
      const room = current.roomId && rooms.get(current.roomId);
      const target = room && room.peers.get(message.to);
      if (!target || !message.data) return;
      return send(target.ws, { type: 'signal', from: current.id, fromName: current.name, data: message.data });
    }

    if (message.type === 'chat') {
      const room = current.roomId && rooms.get(current.roomId);
      if (!room) return;
      const text = String(message.text || '').trim().slice(0, 500);
      if (text) broadcast(room, { type: 'chat', from: current.name, text, at: Date.now() });
      return;
    }
  });
  ws.on('close', () => removePeer(ws));
  ws.on('error', () => removePeer(ws));
});

server.listen(PORT, () => console.log(`Watch Party MVP running at http://localhost:${PORT}`));
