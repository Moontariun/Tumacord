import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { TumacordDiscovery } = require('../desktop/discovery.cjs') as {
  TumacordDiscovery: new (onChange: (calls: unknown[]) => void, options: { createSocket: () => FakeSocket; networkInterfaces?: () => NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]> }) => { close(): void; refreshInterfaces(): void };
};

class FakeSocket extends EventEmitter {
  closeCalls = 0;
  memberships: string[] = [];
  droppedMemberships: string[] = [];
  private running = false;

  bind(_port: number, _host: string, callback: () => void): void {
    this.running = true;
    callback();
  }

  setBroadcast(): void {}
  setMulticastTTL(): void {}
  addMembership(_group: string, address: string): void { this.memberships.push(address); }
  dropMembership(_group: string, address: string): void { this.droppedMemberships.push(address); }
  send(_packet: Buffer, _port: number, _target: string, callback: (error?: Error) => void): void { callback(); }
  stopExternally(): void { this.running = false; }

  close(): void {
    this.closeCalls += 1;
    if (!this.running) {
      const error = new Error('Not running') as NodeJS.ErrnoException;
      error.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
      throw error;
    }
    this.running = false;
  }
}

test('encerrar a descoberta várias vezes fecha o socket UDP somente uma vez', () => {
  const socket = new FakeSocket();
  const discovery = new TumacordDiscovery(() => undefined, { createSocket: () => socket });
  assert.doesNotThrow(() => discovery.close());
  assert.doesNotThrow(() => discovery.close());
  assert.equal(socket.closeCalls, 1);
});

test('fechar depois que o UDP já parou ignora somente ERR_SOCKET_DGRAM_NOT_RUNNING', () => {
  const socket = new FakeSocket();
  const discovery = new TumacordDiscovery(() => undefined, { createSocket: () => socket });
  socket.stopExternally();
  assert.doesNotThrow(() => discovery.close());
  assert.equal(socket.closeCalls, 1);
});

test('interface ZeroTier que aparece ou some atualiza o multicast sem reiniciar', () => {
  const socket = new FakeSocket();
  let addresses = ['10.10.10.2'];
  const networkInterfaces = () => ({
    zt: addresses.map((address) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24` })),
  });
  const discovery = new TumacordDiscovery(() => undefined, { createSocket: () => socket, networkInterfaces });
  assert.deepEqual(socket.memberships, ['10.10.10.2']);
  addresses = ['10.10.20.2'];
  discovery.refreshInterfaces();
  assert.deepEqual(socket.memberships, ['10.10.10.2', '10.10.20.2']);
  assert.deepEqual(socket.droppedMemberships, ['10.10.10.2']);
  discovery.close();
});
