import net from 'node:net';

// TK103 packets from the original protocol docs / v1 readme, shared by the
// integration suites (unit tests keep their own protocol-specific fixtures).
export const TK103_LOGIN =
  '(012341234123BP05000012341234123140607A3330.4288S07036.8518W019.2230104172.3900000000L00019C2C)';
export const TK103_PING =
  '(012341234123BR00140607A3330.4288S07036.8518W019.2230104172.3900000000L00019C2C)';
export const TK103_DEVICE_ID = '012341234123';

/** Connect to 127.0.0.1:port; `track` receives the socket for cleanup bookkeeping. */
export function connect(port: number, track: (socket: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
    track(socket);
  });
}
