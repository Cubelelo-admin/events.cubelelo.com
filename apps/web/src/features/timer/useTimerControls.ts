"use client";

import { useCallback, useEffect } from "react";

interface TimerControlOptions {
  /** Press — starts inspection, arms, and (while solving) stops. */
  down: () => void;
  /** Release — starts the solve from the armed state. */
  up: () => void;
  /** Escape — abandon the current attempt. Optional. */
  reset?: () => void;
  /** Current timer phase, so an any-key stop only fires while solving. */
  phase: string;
  /** Attach the window key listeners only while true (e.g. terminal is ready). */
  enabled?: boolean;
}

/**
 * The one place the timer's keyboard + pointer input is wired.
 *
 * Every timer surface — the competition terminal, the practice terminal, the
 * daily challenge, and the onboarding tutorial — used to hand-write this, and
 * they drifted: the tutorial only handled Space and no touch, so it did not
 * behave like the real timer it was meant to teach. This is the competition
 * terminal's behaviour, verbatim, shared so they cannot diverge again.
 *
 * Behaviour (WCA-style):
 *  - hold Space to arm, release to start;
 *  - while solving, ANY key (or a tap) stops;
 *  - Escape abandons the attempt.
 */
export function useTimerControls({ down, up, reset, phase, enabled = true }: TimerControlOptions) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Once solving, any key stops — a competitor may slap any key down.
      if (phase === "solving") {
        e.preventDefault();
        down();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        down();
      } else if (e.key === "Escape") {
        reset?.();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        up();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled, phase, down, up, reset]);

  // Touch/click on the timer surface. A settled ("stopped") timer ignores taps
  // until reset, matching the engine's own guard.
  const onPointerDown = useCallback(() => {
    if (!enabled || phase === "stopped") return;
    down();
  }, [enabled, phase, down]);
  const onPointerUp = useCallback(() => {
    if (!enabled || phase === "stopped") return;
    up();
  }, [enabled, phase, up]);

  return { onPointerDown, onPointerUp };
}
