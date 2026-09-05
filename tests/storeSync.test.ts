import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    const simultaneous = { ...message, id: '703d5fc0-533e-46cc-a6ad-4a3b10eac347', body: 'pacote repetido' };
    assert.equal((await store.mergeMessages([simultaneous, simultaneous])).length, 1);
    assert.equal(store.messages.filter((candidate) => candidate.id === simultaneous.id).length, 1);

    const channel = { id: 'qa', name: 'QA', type: 'text' as const };
    assert.equal((await store.mergeChannels([channel, channel])).length, 1);
    assert.equal(store.channels.filter((candidate) => candidate.id === channel.id).length, 1);

    const attachmentId = '158ca2bd-0a13-421e-8b1a-d6e9972f5b38';
    const attachment = { id: attachmentId, name: '../ relatório QA #1.txt', mimeType: 'text/plain', size: 8 };
    await store.saveAttachment(attachmentId, Buffer.from('tumacord'), attachment);
    assert.equal(await store.hasAttachment(attachmentId), true);
    assert.equal((await store.readAttachment(attachmentId)).toString(), 'tumacord');
    assert.deepEqual(store.attachmentForId(attachmentId), attachment);

    const reopened = new JsonStore(directory);
    await reopened.load();
    assert.deepEqual(reopened.attachmentForId(attachmentId), attachment, 'metadados do upload sobrevivem antes de existir mensagem');
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

    const avatarId = '62d7a46f-feae-4678-919f-8a20aee7a09c';
    const withMissingAvatar = { ...newer, profile: { ...newer.profile, avatar: { id: avatarId, mimeType: 'image/png' }, updatedAt: '2026-08-30T14:00:00.000Z' } };
    assert.equal((await store.mergeProfiles([withMissingAvatar])).length, 0, 'metadado não pode vencer antes de o arquivo existir');
    assert.equal(store.profileForUsername('ana')?.avatar, undefined);
    await store.saveAttachment(avatarId, Buffer.from('avatar'));
    assert.equal((await store.mergeProfiles([withMissingAvatar])).length, 1);
    assert.equal(store.profileForUsername('ana')?.avatar?.id, avatarId);

    const reopened = new JsonStore(directory);
    await reopened.load();
    assert.equal(reopened.profileForUsername('Ana')?.bio, 'foto e perfil novos');

    await rm(path.join(directory, 'attachments', avatarId));
    const repaired = new JsonStore(directory);
    await repaired.load();
    assert.equal(repaired.profileForUsername('Ana')?.avatar, undefined, 'carga remove referência para arquivo perdido');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('edições simultâneas de perfil convergem com desempate determinístico', async () => {
  const firstDirectory = await mkdtemp(path.join(tmpdir(), 'tumacord-profile-a-'));
  const secondDirectory = await mkdtemp(path.join(tmpdir(), 'tumacord-profile-b-'));
  try {
    const firstStore = new JsonStore(firstDirectory);
    const secondStore = new JsonStore(secondDirectory);
    await Promise.all([firstStore.load(), secondStore.load()]);
    const timestamp = '2026-08-30T15:00:00.000Z';
    const first = { username: 'Ana', profile: { bio: 'edição alfa', accentColor: '#aa0000', updatedAt: timestamp } };
    const second = { username: 'ANA', profile: { bio: 'edição beta', accentColor: '#bb0000', updatedAt: timestamp } };
    await firstStore.mergeProfiles([first]);
    await secondStore.mergeProfiles([second]);
    await Promise.all([firstStore.mergeProfiles([second]), secondStore.mergeProfiles([first])]);
    assert.deepEqual(firstStore.profileForUsername('ana'), secondStore.profileForUsername('ana'));
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('uma falha de escrita não impede as persistências seguintes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-save-recovery-'));
  const store = new JsonStore(directory);
  await store.load();
  await rm(directory, { recursive: true, force: true });
  await assert.rejects(store.addChannel({ id: 'durante-falha', name: 'Durante falha', type: 'text' }));
  await mkdir(path.join(directory, 'attachments'), { recursive: true });
  await store.addChannel({ id: 'apos-falha', name: 'Após falha', type: 'text' });

  const reopened = new JsonStore(directory);
  await reopened.load();
  assert.equal(reopened.channels.some((channel) => channel.id === 'durante-falha'), true);
  assert.equal(reopened.channels.some((channel) => channel.id === 'apos-falha'), true);
  await rm(directory, { recursive: true, force: true });
});
