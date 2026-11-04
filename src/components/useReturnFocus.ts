'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// These dialogs are mounted conditionally. Their parent removes them immediately
// after closing, so the library's exit-animation focus restoration may not run.
export function useReturnFocus(fallback = '#main-content h1') {
  const [trigger] = useState<HTMLElement | null>(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.requestAnimationFrame(() => {
        // React Strict Mode replays effects on mount; only restore after a real removal.
        if (mounted.current) return;
        const target = trigger?.isConnected && trigger !== document.body && !trigger.matches(':disabled')
          ? trigger
          : document.querySelector<HTMLElement>(fallback);
        target?.focus({ preventScroll: true });
      });
    };
  }, [trigger, fallback]);
}

export function FocusReturn({ children, fallback }: { children: ReactNode; fallback?: string }) {
  useReturnFocus(fallback);
  return children;
}
