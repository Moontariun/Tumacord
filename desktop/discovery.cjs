const dgram = require('node:dgram');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const PORT = 3928;
const GROUP = '239.255.42.99';
const MAGIC = 'tumacord-discovery-v1';

function socketStopped(error) {
  return error?.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING';
}

function ipv4ToNumber(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function numberToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function interfaces(readNetworkInterfaces = os.networkInterfaces) {
  return Object.values(readNetworkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal);
}

function broadcastAddresses(readNetworkInterfaces = os.networkInterfaces) {
  return [...new Set(interfaces(readNetworkInterfaces).map((entry) => numberToIpv4((ipv4ToNumber(entry.address) | (~ipv4ToNumber(entry.netmask) >>> 0)) >>> 0)))];
}

class TumacordDiscovery {
  constructor(onChange, { createSocket = dgram.createSocket, networkInterfaces = os.networkInterfaces } = {}) {
    this.hostId = randomUUID();
    this.onChange = onChange;
    this.calls = new Map();
    this.hosting = null;
    this.closed = false;
    this.readNetworkInterfaces = networkInterfaces;
    this.memberships = new Set();
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (error) => {
      if (!this.closed && !socketStopped(error)) console.warn('Tumacord discovery:', error.message);
    });
    this.socket.on('message', (buffer, remote) => this.onMessage(buffer, remote));
    this.socket.bind(PORT, '0.0.0.0', () => {
      if (this.closed) {
        this.closeSocket();
        return;
      }
      this.socket.setBroadcast(true);
      this.socket.setMulticastTTL(8);
      this.refreshInterfaces();
      this.probe();
    });
    this.timer = setInterval(() => {
      this.prune();
      this.refreshInterfaces();
      this.probe();
      if (this.hosting) this.broadcast({ type: 'advertise', ...this.hosting });
    }, 1000);
    this.timer.unref();
  }

  setHosting(details) {
    if (this.closed) return;
    this.hosting = details ? { ...details, hostId: this.hostId, port: 3927 } : null;
    if (this.hosting) this.broadcast({ type: 'advertise', ...this.hosting });
  }

  list() {
    return [...this.calls.values()].sort((a, b) => a.pingMs - b.pingMs || a.hostUsername.localeCompare(b.hostUsername));
  }

  probe() {
    if (this.closed) return;
    this.broadcast({ type: 'probe', nonce: randomUUID(), probeSentAt: Date.now() });
  }

  refreshInterfaces() {
    if (this.closed) return;
    const current = new Set(interfaces(this.readNetworkInterfaces).map((entry) => entry.address));
    for (const address of current) {
      if (this.memberships.has(address)) continue;
      try {
        this.socket.addMembership(GROUP, address);
        this.memberships.add(address);
      } catch { /* interface sem multicast ou ainda em transição */ }
    }
    for (const address of this.memberships) {
      if (current.has(address)) continue;
      try { this.socket.dropMembership?.(GROUP, address); } catch { /* a interface já desapareceu */ }
      this.memberships.delete(address);
    }
  }

  send(packet, port, target) {
    if (this.closed) return;
    try {
      this.socket.send(packet, port, target, (error) => {
        if (error && !this.closed && !socketStopped(error)) console.warn('Tumacord discovery:', error.message);
      });
    } catch (error) {
      if (!this.closed && !socketStopped(error)) console.warn('Tumacord discovery:', error.message);
    }
  }

  broadcast(payload) {
    if (this.closed) return;
    const packet = Buffer.from(JSON.stringify({ magic: MAGIC, ...payload }));
    for (const target of [...broadcastAddresses(this.readNetworkInterfaces), GROUP]) this.send(packet, PORT, target);
  }

  onMessage(buffer, remote) {
    if (this.closed) return;
    let message;
    try { message = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (message.magic !== MAGIC) return;
    if (message.type === 'probe' && this.hosting) {
      const packet = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'advertise', ...this.hosting, nonce: message.nonce, probeSentAt: message.probeSentAt }));
      this.send(packet, remote.port, remote.address);
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
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.hosting = null;
    this.calls.clear();
    this.memberships.clear();
    this.closeSocket();
  }

  closeSocket() {
    try {
      this.socket.close();
    } catch (error) {
      if (!socketStopped(error)) throw error;
    }
  }
}

module.exports = { TumacordDiscovery };
