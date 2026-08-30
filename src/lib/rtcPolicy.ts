export function isPolitePeer(selfId: string, remoteId: string): boolean {
  return selfId.localeCompare(remoteId) > 0;
}

export function shouldInitiateRecovery(selfId: string, remoteId: string): boolean {
  return selfId.localeCompare(remoteId) < 0;
}

export function shouldQueueIceCandidate(hasRemoteDescription: boolean): boolean {
  return !hasRemoteDescription;
}
