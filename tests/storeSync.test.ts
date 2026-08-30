import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../server/store.js';

test('mescla histórico distribuído sem duplicar mensagens e guarda anexos locais', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-sync-'));
  try {
    const store = new JsonStore(directory);
    await store.load();
    const message = {
      id: 'b8620030-b417-4d1a-a8a6-3ef586edb5cf',
      channelId: 'geral',
      author: { id: 'ana', username: 'Ana' },
      body: 'histórico compartilhado',
      createdAt: '2026-08-30T12:00:00.000Z',
    };
    assert.equal((await store.mergeMessages([message])).length, 1);
    assert.equal((await store.mergeMessages([message])).length, 0);
    assert.equal(store.messages.length, 1);

    const attachmentId = '158ca2bd-0a13-421e-8b1a-d6e9972f5b38';
    await store.saveAttachment(attachmentId, Buffer.from('tumacord'));
    assert.equal(await store.hasAttachment(attachmentId), true);
    assert.equal((await store.readAttachment(attachmentId)).toString(), 'tumacord');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
