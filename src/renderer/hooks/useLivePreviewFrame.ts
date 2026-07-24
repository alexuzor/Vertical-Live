/**
 * Subscribes to the real MJPEG preview frames the main process emits during an
 * active session and exposes the latest as an object URL. Bounded to two live
 * URLs at a time and revoked on unmount, so memory stays flat over a long
 * broadcast. Under the browser mock (no frames) it simply stays null.
 */

import { useEffect, useState } from 'react';

import { getApi } from '../lib/api';

export function useLivePreviewFrame(enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(null);
      return;
    }

    const alive: string[] = [];
    const unsubscribe = getApi().onPreviewFrame((frame) => {
      const blob = new Blob([new Uint8Array(frame)], { type: 'image/jpeg' });
      const next = URL.createObjectURL(blob);
      alive.push(next);
      while (alive.length > 2) {
        const stale = alive.shift();
        if (stale) URL.revokeObjectURL(stale);
      }
      setUrl(next);
    });

    return () => {
      unsubscribe();
      for (const u of alive) URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [enabled]);

  return url;
}
