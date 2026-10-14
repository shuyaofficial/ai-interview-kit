// テスト用の最小 WebSocket サーバー（RFC 6455 のうち、テキストフレームと close だけ）。127.0.0.1 の空きポートで待ち受ける。
// 実際の API は呼ばない。compare-voice-api のテストで、偽の OpenAI / Gemini として使う。
import http from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (len >= 65536) head.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([head, payload]);
}

/** buf の先頭から完全なフレームを取り出す。足りなければ null。 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let len = buf[1] & 127;
  let pos = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); pos = 4; } else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); pos = 10; }
  const maskKey = masked ? buf.subarray(pos, pos + 4) : null;
  if (masked) pos += 4;
  if (buf.length < pos + len) return null;
  const payload = Buffer.from(buf.subarray(pos, pos + len));
  if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  return { opcode, payload, rest: buf.subarray(pos + len) };
}

/**
 * @param {(conn: {send:(obj:object)=>void, close:(code?:number,reason?:string)=>void, onMessage:(fn:(msg:object)=>void)=>void, url:string, headers:object}) => void} onConnection
 * @param {{reject?: number}} [opts] reject: 握手の代わりにこの HTTP ステータスを返す
 */
export async function startFakeWs(onConnection, { reject = 0 } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (reject) { socket.end(`HTTP/1.1 ${reject} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const handlers = [];
    const conn = {
      url: req.url,
      headers: req.headers,
      send: (obj) => { if (!socket.destroyed) socket.write(encodeFrame(1, Buffer.from(JSON.stringify(obj)))); },
      close: (code = 1000, reason = '') => { const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code); p.write(reason, 2); if (!socket.destroyed) socket.write(encodeFrame(8, p)); },
      onMessage: (fn) => handlers.push(fn),
    };
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let f = decodeFrame(buf); f; f = decodeFrame(buf)) {
        buf = Buffer.from(f.rest);
        if (f.opcode === 1) { let msg; try { msg = JSON.parse(f.payload.toString('utf8')); } catch { continue; } handlers.forEach((h) => h(msg)); }
        else if (f.opcode === 8) socket.end(encodeFrame(8, f.payload));
      }
    });
    onConnection(conn);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
  };
}
