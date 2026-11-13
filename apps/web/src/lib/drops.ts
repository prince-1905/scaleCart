import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { Drop, QueueStatus } from './types';

/** Drops that start soon or started in the last day. Refreshed every 15 s (stock goes down during a drop). */
export function useDrops() {
  return useQuery({ queryKey: ['drops'], queryFn: () => api<Drop[]>('/drops'), refetchInterval: 15_000 });
}

/**
 * "Now" on the server's clock, ticking every second. The countdown must not depend on the visitor's clock
 * (it can be minutes off); the API sends its time with every drop list, so we keep the offset.
 */
export function useServerNow(serverTime: string | undefined): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (serverTime) setOffset(Date.parse(serverTime) - Date.now());
  }, [serverTime]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now + offset;
}

/**
 * Your place in a drop's line. Joining and asking "where am I?" are the same call, so this just repeats it:
 * as often as the API's estimate suggests (between 1 and 5 s), and not at all once your number is called.
 */
export function useQueue(dropId: number, joined: boolean) {
  return useQuery({
    queryKey: ['queue', dropId],
    queryFn: () => api<QueueStatus>(`/drops/${dropId}/queue`, { method: 'POST' }),
    enabled: joined,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (q.state.error) return 3000; // "waiting room busy" (503): try again shortly
      if (!s || s.admitted) return false;
      if (s.soldOut) return 10_000; // check now and then: an unpaid order may expire and free a unit
      return Math.min(5, Math.max(1, s.etaSeconds)) * 1000;
    },
    retry: 2,
  });
}
