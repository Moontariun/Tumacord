const dgram = require('node:dgram');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const PORT = 3928;
const GROUP = '239.255.42.99';
const MAGIC = 'tumacord-discovery-v1';

function ipv4ToNumber(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function numberToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function interfaces() {
  return Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal);
}

function broadcastAddresses() {
  return [...new Set(interfaces().map((entry) => numberToIpv4((ipv4ToNumber(entry.address) | (~ipv4ToNumber(entry.netmask) >>> 0)) >>> 0)))];
}

class TumacordDiscovery {
  constructor(onChange) {
    this.hostId = randomUUID();
    this.onChange = onChange;
    this.calls = new Map();
    this.hosting = null;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (error) => console.warn('Tumacord discovery:', error.message));
    this.socket.on('message', (buffer, remote) => this.onMessage(buffer, remote));
    this.socket.bind(PORT, '0.0.0.0', () => {
      this.socket.setBroadcast(true);
      this.socket.setMulticastTTL(8);
      for (const entry of interfaces()) {
        try { this.socket.addMembership(GROUP, entry.address); } catch { /* interface sem multicast */ }
      }
      this.probe();
    });
    this.timer = setInterval(() => {
      this.prune();
      this.probe();
      if (this.hosting) this.broadcast({ type: 'advertise', ...this.hosting });
    }, 1000);
    this.timer.unref();
  }

  setHosting(details) {
    this.hosting = details ? { ...details, hostId: this.hostId, port: 3927 } : null;
    if (this.hosting) this.broadcast({ type: 'advertise', ...this.hosting });
  }

  list() {
    return [...this.calls.values()].sort((a, b) => a.pingMs - b.pingMs || a.hostUsername.localeCompare(b.hostUsername));
  }

  probe() {
    this.broadcast({ type: 'probe', nonce: randomUUID(), probeSentAt: Date.now() });
  }

  broadcast(payload) {
    const packet = Buffer.from(JSON.stringify({ magic: MAGIC, ...payload }));
    for (const target of [...broadcastAddresses(), GROUP]) {
      this.socket.send(packet, PORT, target, () => undefined);
    }
  }

  onMessage(buffer, remote) {
    let message;
    try { message = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (message.magic !== MAGIC) return;
    if (message.type === 'probe' && this.hosting) {
      const packet = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'advertise', ...this.hosting, nonce: message.nonce, probeSentAt: message.probeSentAt }));
      this.socket.send(packet, remote.port, remote.address, () => undefined);
      return;
    }
    if (message.type !== 'advertise' || message.hostId === this.hostId || !message.callId || !message.hostUsername) return;
    const key = `${message.hostId}:${message.callId}`;
    const previous = this.calls.get(key);
    const measured = Number.isFinite(message.probeSentAt) ? Math.max(1, Date.now() - message.probeSentAt) : previous?.pingMs ?? 999;
    this.calls.set(key, {
      hostId: message.hostId,
      hostUserId: message.hostUserId,
      hostUsername: message.hostUsername,
      callId: message.callId,
      callName: message.callName || 'Call Geral',
      participants: Number(message.participants) || 1,
      url: `http://${remote.address}:3927`,
      pingMs: measured,
      lastSeen: Date.now(),
    });
    this.onChange(this.list());
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [key, call] of this.calls) {
      if (now - call.lastSeen > 3500) { this.calls.delete(key); changed = true; }
    }
    if (changed) this.onChange(this.list());
  }

  close() {
    clearInterval(this.timer);
    this.socket.close();
  }
}

module.exports = { TumacordDiscovery };
