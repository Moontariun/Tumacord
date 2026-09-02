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

test('perfil distribuído usa sempre a edição mais nova e persiste entre hosts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-profile-sync-'));
  try {
    const store = new JsonStore(directory);
    await store.load();
    await store.addUser({
      id: 'ana-local',
      username: 'Ana',
      normalizedUsername: 'ana',
      passwordHash: 'test-only',
      createdAt: '2026-08-30T10:00:00.000Z',
    });
    const first = {
      username: 'Ana',
      profile: { bio: 'primeiro perfil', accentColor: '#ff0000', updatedAt: '2026-08-30T12:00:00.000Z' },
    };
    assert.equal((await store.mergeProfiles([first])).length, 1);
    assert.equal(store.profileForUsername('ANA')?.bio, 'primeiro perfil');

    const older = { ...first, profile: { ...first.profile, bio: 'cópia antiga', updatedAt: '2026-08-30T11:00:00.000Z' } };
    assert.equal((await store.mergeProfiles([older])).length, 0);
    assert.equal(store.profileForUsername('ana')?.bio, 'primeiro perfil');

    const newer = { ...first, profile: { ...first.profile, bio: 'foto e perfil novos', updatedAt: '2026-08-30T13:00:00.000Z' } };
    assert.equal((await store.mergeProfiles([newer])).length, 1);
    assert.equal(store.users[0].profile?.bio, 'foto e perfil novos');

    const reopened = new JsonStore(directory);
    await reopened.load();
    assert.equal(reopened.profileForUsername('Ana')?.bio, 'foto e perfil novos');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
