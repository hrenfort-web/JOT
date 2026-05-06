import { useEffect, useState } from 'react';
import * as Network from 'expo-network';

const POLL_INTERVAL_MS = 10_000;

type Listener = (online: boolean) => void;

let currentOnline = true;
let listeners: Listener[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

export function isOnline(): boolean {
  return currentOnline;
}

export function addConnectivityListener(cb: Listener): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

async function checkOnce(): Promise<void> {
  try {
    const state = await Network.getNetworkStateAsync();
    const next =
      Boolean(state.isConnected) && state.isInternetReachable !== false;
    if (next !== currentOnline) {
      currentOnline = next;
      for (const cb of listeners) {
        try {
          cb(currentOnline);
        } catch {
          // listener errors should not break the monitor
        }
      }
    }
  } catch {
    // ignore network probe errors
  }
}

export async function refreshConnectivity(): Promise<boolean> {
  await checkOnce();
  return currentOnline;
}

export function startConnectivityMonitor(): void {
  if (started) return;
  started = true;
  checkOnce();
  pollTimer = setInterval(checkOnce, POLL_INTERVAL_MS);
}

export function stopConnectivityMonitor(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(currentOnline);
  useEffect(() => {
    setOnline(currentOnline);
    return addConnectivityListener(setOnline);
  }, []);
  return online;
}
