import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { SessionStore } from './sessions.js';
import { C2S, S2C, ERR, parse, send, fail } from './protocol.js';

const PORT = Number(process.env.PORT ?? 8080);
const CODE_TTL_SEC = Number(process.env.CODE_TTL_SEC ?? 120);
const HEARTBEAT_SEC = Number(process.env.HEARTBEAT_SEC ?? 30);
// Gracia para reanudar una sesion tras una caida de red (segundos).
const GRACE_SEC = Number(process.env.GRACE_SEC ?? 20);
// Tope de tamano por mensaje de senalizacion (bytes). Endurecimiento: los
// mensajes solo llevan SDP/ICE pequenos; el media va aparte por WebRTC.
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD ?? 256 * 1024);
// Secreto compartido opcional. Si se define, cada socket debe traer ?token=...
// En produccion se usa junto con wss:// (TLS termina en un proxy delante).
const SIGNAL_TOKEN = process.env.SIGNAL_TOKEN ?? '';

const store = new SessionStore({ codeTtlSec: CODE_TTL_SEC });

// Servidor HTTP minimo: solo /health. El WS se monta encima.
const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: store.sessions.size }));
  } else {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });

function tokenOf(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

wss.on('connection', (ws, req) => {
  if (SIGNAL_TOKEN && tokenOf(req) !== SIGNAL_TOKEN) {
    ws.close(4401, 'unauthorized');
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handle(ws, raw));
  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

function handle(ws, raw) {
  const msg = parse(raw);
  if (!msg) return fail(ws, ERR.BAD_MESSAGE);

  switch (msg.type) {
    case C2S.HOST_REGISTER: {
      if (!msg.deviceId) return fail(ws, ERR.BAD_MESSAGE, 'deviceId requerido');
      const res = store.registerHost(ws, String(msg.deviceId), msg.password);
      if (!res.ok) return fail(ws, ERR.ID_TAKEN, 'ese ID ya está en uso');
      return send(ws, S2C.REGISTERED, { deviceId: msg.deviceId, unattended: res.unattended });
    }

    case C2S.HOST_SET_UNATTENDED: {
      if (ws.role !== 'host') return fail(ws, ERR.NOT_REGISTERED);
      store.setUnattended(ws.deviceId, !!msg.enabled, msg.password);
      return send(ws, S2C.UNATTENDED_STATE, { enabled: !!msg.enabled });
    }

    case C2S.CODE_CREATE: {
      if (ws.role !== 'host') return fail(ws, ERR.NOT_REGISTERED);
      const res = store.createCode(ws.deviceId);
      if (!res) return fail(ws, ERR.NOT_REGISTERED);
      return send(ws, S2C.CODE_CREATED, res);
    }

    case C2S.VIEWER_JOIN_CODE: {
      const hostWs = store.consumeCode(String(msg.code ?? ''));
      if (!hostWs) return fail(ws, ERR.CODE_INVALID);
      return bind(ws, hostWs);
    }

    case C2S.VIEWER_JOIN_ID: {
      const r = store.resolveUnattended(String(msg.deviceId ?? ''), msg.password);
      if (r.reason === 'offline') return fail(ws, ERR.DEVICE_OFFLINE);
      if (r.reason === 'disabled') return fail(ws, ERR.UNATTENDED_DISABLED);
      if (r.reason === 'locked') {
        return fail(ws, ERR.LOCKED, `demasiados intentos; espera ${Math.ceil(r.retryMs / 1000)}s`);
      }
      if (r.reason === 'bad-password') return fail(ws, ERR.BAD_PASSWORD);
      return bind(ws, r.ws);
    }

    case C2S.PRESENCE_QUERY: {
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      const online = {};
      for (const id of ids) online[String(id)] = store.isOnline(String(id));
      return send(ws, S2C.PRESENCE, { online });
    }

    case C2S.RESUME: {
      const res = store.resume(String(msg.token ?? ''), ws, msg.role === 'host' ? 'host' : 'viewer');
      if (!res) return fail(ws, ERR.RESUME_FAILED);
      send(ws, S2C.RESUMED, { sessionId: res.sessionId });
      // El peer dispara un ICE restart para recuperar el media sin reiniciar.
      send(res.peer, S2C.PEER_RESUMED, { sessionId: res.sessionId });
      return;
    }

    // Relay de senalizacion WebRTC: offer/answer/ice van al peer, sin tocarse.
    case C2S.OFFER:
    case C2S.ANSWER:
    case C2S.ICE: {
      const peer = store.peerOf(ws);
      if (!peer) return fail(ws, ERR.NO_PEER);
      return send(peer, msg.type, { payload: msg.payload });
    }

    case C2S.BYE: {
      const peer = store.leave(ws);
      if (peer) send(peer, S2C.PEER_LEFT, { reason: 'bye' });
      return;
    }

    default:
      return fail(ws, ERR.BAD_MESSAGE, `tipo desconocido: ${msg.type}`);
  }
}

function bind(viewerWs, hostWs) {
  const { sessionId, token, displaced } = store.pair(hostWs, viewerWs);
  if (displaced) send(displaced, S2C.PEER_LEFT, { reason: 'replaced' });
  // Ambos reciben el token: les permite reanudar si se cae la red.
  send(hostWs, S2C.VIEWER_JOINED, { sessionId, token, graceSec: GRACE_SEC });
  send(viewerWs, S2C.JOINED, { sessionId, token, graceSec: GRACE_SEC });
}

function cleanup(ws) {
  // Si estaba en una sesion viva, se suspende con gracia para reanudar.
  const sus = store.suspend(ws);
  if (sus) {
    send(sus.peer, S2C.PEER_SUSPENDED, { reason: 'disconnected', graceSec: GRACE_SEC });
    const timer = setTimeout(() => {
      const peer = store.finalize(sus.sessionId);
      if (peer) send(peer, S2C.PEER_LEFT, { reason: 'timeout' });
    }, GRACE_SEC * 1000);
    timer.unref();
  }
  store.dropHost(ws);
}

// Keepalive: cierra sockets que no respondan al ping.
const heartbeat = setInterval(() => {
  store.purgeExpiredCodes();
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_SEC * 1000);
heartbeat.unref();

http.listen(PORT, () => {
  const p = http.address().port;
  console.log(`[RemotaTSL] senalizacion en ws://localhost:${p}  (health: /health)`);
});

export { http, wss, store };
