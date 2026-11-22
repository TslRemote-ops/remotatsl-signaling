import { randomInt, randomUUID } from 'node:crypto';

// Estado en memoria. Estructuras minimas:
//  - hosts:    deviceId -> { ws, unattended }     (clientes conectados)
//  - codes:    code     -> { deviceId, expiresAt } (codigos de un solo uso)
//  - sessions: sessionId-> { hostWs, viewerWs, token, suspended }
//  - byToken:  token    -> sessionId               (para reanudar)
// Cada ws lleva marcadas sus referencias: ws.role, ws.deviceId, ws.sessionId.

export class SessionStore {
  constructor({ codeTtlSec = 120 } = {}) {
    this.codeTtlMs = codeTtlSec * 1000;
    this.hosts = new Map();
    this.codes = new Map();
    this.sessions = new Map();
    this.byToken = new Map();
    // Anti fuerza-bruta: deviceId -> { count, until } (bloqueo por intentos fallidos).
    this.locks = new Map();
    this._seq = 0;
  }

  // Registra al host. Si ya hay OTRA conexion viva con el mismo ID, solo se permite
  // el relevo si demuestra la contrasena del equipo: asi, conocer el ID (que se le
  // dicta al tecnico) no basta para expulsar al cliente real (DoS). Devuelve
  // { ok, unattended } o { ok:false, reason:'id-taken' }.
  registerHost(ws, deviceId, password) {
    const prev = this.hosts.get(deviceId);
    const prevAlive = prev && prev.ws !== ws && prev.ws.readyState === 1; // 1 = OPEN
    if (prevAlive) {
      if (prev.password && String(password ?? '') !== prev.password) {
        return { ok: false, reason: 'id-taken' };
      }
      this._closeQuietly(prev.ws); // relevo autenticado (o aun sin contrasena fijada)
    }
    const unattended = prev ? prev.unattended : false;
    const storedPw = (prev && prev.password) ? prev.password : (password ? String(password) : '');
    this.hosts.set(deviceId, { ws, unattended, password: storedPw });
    ws.role = 'host';
    ws.deviceId = deviceId;
    return { ok: true, unattended };
  }

  // La contrasena solo vive en memoria mientras el host esta conectado; nunca
  // se persiste. Si llega undefined, se conserva la que hubiera.
  setUnattended(deviceId, enabled, password) {
    const host = this.hosts.get(deviceId);
    if (!host) return false;
    host.unattended = !!enabled;
    if (password !== undefined && password !== null) host.password = String(password);
    return true;
  }

  createCode(deviceId) {
    if (!this.hosts.has(deviceId)) return null;
    let code;
    do {
      code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    } while (this.codes.has(code));
    this.codes.set(code, { deviceId, expiresAt: Date.now() + this.codeTtlMs });
    return { code, ttlSec: this.codeTtlMs / 1000 };
  }

  consumeCode(code) {
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    if (Date.now() > entry.expiresAt) return null;
    const host = this.hosts.get(entry.deviceId);
    return host ? host.ws : null;
  }

  // Un equipo esta "en linea" si esta registrado y acepta acceso por ID.
  isOnline(deviceId) {
    const host = this.hosts.get(deviceId);
    return !!(host && host.unattended);
  }

  resolveUnattended(deviceId, password) {
    const host = this.hosts.get(deviceId);
    if (!host) return { ws: null, reason: 'offline' };
    if (!host.unattended) return { ws: null, reason: 'disabled' };

    // Anti fuerza-bruta: tras varios fallos, bloqueo creciente por ID.
    const now = Date.now();
    const lock = this.locks.get(deviceId);
    if (lock && lock.until > now) {
      return { ws: null, reason: 'locked', retryMs: lock.until - now };
    }

    // Si el host definio contrasena, debe coincidir.
    if (host.password && String(password ?? '') !== host.password) {
      const l = lock ?? { count: 0, until: 0 };
      l.count += 1;
      if (l.count >= 5) {
        // 5+ fallos: 30s, 60s, 120s... hasta 5 min.
        l.until = now + Math.min(300000, 30000 * 2 ** (l.count - 5));
      }
      this.locks.set(deviceId, l);
      return { ws: null, reason: 'bad-password' };
    }

    this.locks.delete(deviceId); // exito: reinicia el contador
    return { ws: host.ws, reason: null };
  }

  // Empareja host y viewer. Devuelve { sessionId, token, displaced }.
  pair(hostWs, viewerWs) {
    const prev = this._teardown(hostWs.sessionId);
    const displaced = prev ? (prev.hostWs === hostWs ? prev.viewerWs : prev.hostWs) : null;
    const sessionId = `s${++this._seq}`;
    const token = randomUUID();
    this.sessions.set(sessionId, { hostWs, viewerWs, token, suspended: null });
    this.byToken.set(token, sessionId);
    hostWs.sessionId = sessionId;
    viewerWs.sessionId = sessionId;
    viewerWs.role = 'viewer';
    return { sessionId, token, displaced };
  }

  peerOf(ws) {
    const s = ws.sessionId && this.sessions.get(ws.sessionId);
    if (!s) return null;
    return ws === s.hostWs ? s.viewerWs : s.hostWs;
  }

  purgeExpiredCodes(now = Date.now()) {
    for (const [code, e] of this.codes) {
      if (now > e.expiresAt) this.codes.delete(code);
    }
  }

  // Un socket de una sesion activa se cae: la sesion queda suspendida (gracia).
  // Devuelve { sessionId, peer, missing } o null si no habia sesion viva.
  suspend(ws) {
    const s = ws.sessionId && this.sessions.get(ws.sessionId);
    if (!s || s.suspended) return null;
    const missing = ws === s.hostWs ? 'host' : 'viewer';
    s.suspended = { missing };
    const peer = missing === 'host' ? s.viewerWs : s.hostWs;
    return { sessionId: ws.sessionId, peer, missing };
  }

  // Reanuda una sesion suspendida. Devuelve { sessionId, peer } o null.
  resume(token, newWs, role) {
    const sessionId = this.byToken.get(token);
    const s = sessionId && this.sessions.get(sessionId);
    if (!s || !s.suspended || s.suspended.missing !== role) return null;
    if (role === 'host') { s.hostWs = newWs; newWs.role = 'host'; }
    else { s.viewerWs = newWs; newWs.role = 'viewer'; }
    newWs.sessionId = sessionId;
    s.suspended = null;
    const peer = role === 'host' ? s.viewerWs : s.hostWs;
    return { sessionId, peer };
  }

  // La gracia expiro: si sigue suspendida, se cierra. Devuelve el peer o null.
  finalize(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.suspended) return null;   // ya se reanudo
    const peer = s.suspended.missing === 'host' ? s.viewerWs : s.hostWs;
    this._remove(sessionId);
    return peer;
  }

  // Salida limpia (bye): cierra la sesion ya mismo. Devuelve el peer o null.
  leave(ws) {
    const s = this._teardown(ws.sessionId);
    const peer = s ? (ws === s.hostWs ? s.viewerWs : s.hostWs) : null;
    this.dropHost(ws);
    return peer;
  }

  // Quita al host del mapa si este socket era el titular (sin tocar sesiones).
  dropHost(ws) {
    if (ws.role === 'host' && ws.deviceId) {
      const host = this.hosts.get(ws.deviceId);
      if (host && host.ws === ws) this.hosts.delete(ws.deviceId);
    }
  }

  _teardown(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    this._remove(sessionId);
    s.hostWs.sessionId = undefined;
    s.viewerWs.sessionId = undefined;
    return s;
  }

  _remove(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.byToken.delete(s.token);
  }

  _closeQuietly(ws) {
    try { ws.close(4000, 'replaced'); } catch { /* noop */ }
  }
}
