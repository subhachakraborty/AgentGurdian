import { io, Socket } from 'socket.io-client';

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || browserOrigin || 'http://localhost:3001';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(userId: string) {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  s.emit('join', userId);
}

export function disconnectSocket() {
  if (socket?.connected) {
    socket.disconnect();
  }
}
