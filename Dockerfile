# Servidor de senalizacion RemotaTSL — imagen minima para Koyeb/Render/VPS.
# El video es P2P (WebRTC) y NO pasa por aqui: solo empareja cliente y tecnico.
FROM node:20-alpine
WORKDIR /app

# Dependencias de produccion (capa cacheable).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Codigo del servidor (estructura plana).
COPY server.js sessions.js protocol.js ./

# El host inyecta el puerto por PORT; 8080 es el valor por defecto.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
