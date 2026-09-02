import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { TumacordDiscovery } = require('../desktop/discovery.cjs') as {
  TumacordDiscovery: new (onChange: (calls: unknown[]) => void, options: { createSocket: () => FakeSocket }) => { close(): void };
};

class FakeSocket extends EventEmitter {
  closeCalls = 0;
  private running = false;

  bind(_port: number, _host: string, callback: () => void): void {
    this.running = true;
    callback();
  }

  setBroadcast(): void {}
  setMulticastTTL(): void {}
  addMembership(): void {}
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
