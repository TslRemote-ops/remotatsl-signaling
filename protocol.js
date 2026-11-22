// Tipos de mensaje del canal de senalizacion.
// Solo se intercambia lo minimo para emparejar y negociar WebRTC;
// el video/audio nunca pasa por el servidor.

export const C2S = {
  HOST_REGISTER: 'host-register',     // host (cliente) se anuncia con su deviceId
  HOST_SET_UNATTENDED: 'host-unattended', // activa/desactiva acceso desatendido
  CODE_CREATE: 'code-create',         // host pide un codigo de un solo uso
  VIEWER_JOIN_CODE: 'viewer-join-code',   // tecnico entra con codigo
  VIEWER_JOIN_ID: 'viewer-join-id',   // tecnico entra con deviceId (desatendido)
  PRESENCE_QUERY: 'presence-query',   // tecnico pregunta que equipos estan en linea
  RESUME: 'resume',                   // reanudar una sesion suspendida por token
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE: 'ice',
  BYE: 'bye',
};

export const S2C = {
  REGISTERED: 'registered',
  UNATTENDED_STATE: 'unattended-state',
  CODE_CREATED: 'code-created',
  VIEWER_JOINED: 'viewer-joined',     // al host: llego un tecnico
  JOINED: 'joined',                   // al tecnico: emparejado
  PRESENCE: 'presence',               // al tecnico: que equipos estan en linea
  RESUMED: 'resumed',                 // al que reconecta: sesion recuperada
  PEER_SUSPENDED: 'peer-suspended',   // el peer se cayo; hay gracia para volver
  PEER_RESUMED: 'peer-resumed',       // el peer volvio dentro de la gracia
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE: 'ice',
  PEER_LEFT: 'peer-left',
  ERROR: 'error',
};

export const ERR = {
  BAD_MESSAGE: 'bad-message',
  NOT_REGISTERED: 'not-registered',
  CODE_INVALID: 'code-invalid',
  DEVICE_OFFLINE: 'device-offline',
  UNATTENDED_DISABLED: 'unattended-disabled',
  BAD_PASSWORD: 'bad-password',
  LOCKED: 'locked',           // demasiados intentos de contrasena: bloqueo temporal
  ID_TAKEN: 'id-taken',       // el ID ya tiene un host vivo (relevo no autenticado)
  NO_PEER: 'no-peer',
  RESUME_FAILED: 'resume-failed',
};

export function parse(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg.type !== 'string') return null;
  return msg;
}

export function send(ws, type, data = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

export function fail(ws, code, detail) {
  send(ws, S2C.ERROR, { code, detail });
}
