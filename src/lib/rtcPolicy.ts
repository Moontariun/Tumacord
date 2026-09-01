export function isPolitePeer(selfId: string, remoteId: string): boolean {
  return selfId.localeCompare(remoteId) > 0;
}

export function shouldInitiateRecovery(selfId: string, remoteId: string): boolean {
  return selfId.localeCompare(remoteId) < 0;
}

export function shouldQueueIceCandidate(hasRemoteDescription: boolean): boolean {
  return !hasRemoteDescription;
}

export function shouldRecoverMutedAudio(input: {
  trackMuted: boolean;
  remoteMuted: boolean;
  screen: boolean;
  screenAudioExpected: boolean;
}): boolean {
  if (!input.trackMuted) return false;
  return input.screen ? input.screenAudioExpected : !input.remoteMuted;
}
