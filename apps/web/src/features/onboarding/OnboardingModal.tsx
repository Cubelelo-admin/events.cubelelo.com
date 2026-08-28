"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTimer } from "@/features/timer/useTimer";
import { useTimerControls } from "@/features/timer/useTimerControls";
import { formatTime } from "@cubers/timer-core";

const STORAGE_KEY = "cubers_onboarding_done";

interface OnboardingModalProps {
  onComplete: () => void;
}

type Step = "welcome" | "inspection" | "timer-demo" | "submit-demo" | "ready";

export function useOnboardingGate(): { needsOnboarding: boolean; markDone: () => void } {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    const done = localStorage.getItem(STORAGE_KEY);
    if (done !== "true") setNeedsOnboarding(true);
  }, []);

  const markDone = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "true");
    setNeedsOnboarding(false);
  }, []);

  return { needsOnboarding, markDone };
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [step, setStep] = useState<Step>("welcome");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
        {step === "welcome" && <WelcomeStep onNext={() => setStep("inspection")} onSkip={onComplete} />}
        {step === "inspection" && <InspectionStep onNext={() => setStep("timer-demo")} onBack={() => setStep("welcome")} />}
        {step === "timer-demo" && <TimerDemoStep onNext={() => setStep("submit-demo")} onBack={() => setStep("inspection")} />}
        {step === "submit-demo" && <SubmitDemoStep onNext={() => setStep("ready")} onBack={() => setStep("timer-demo")} />}
        {step === "ready" && <ReadyStep onComplete={onComplete} />}
      </div>
    </div>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? "w-6 bg-emerald-500" : i < current ? "w-3 bg-emerald-500/40" : "w-3 bg-zinc-300 dark:bg-zinc-700"
          }`}
        />
      ))}
    </div>
  );
}

function NavButtons({
  onBack,
  onNext,
  nextLabel = "Next",
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
}) {
  return (
    <div className="mt-6 flex items-center justify-between">
      {onBack ? (
        <button
          onClick={onBack}
          className="rounded-lg px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Back
        </button>
      ) : (
        <div />
      )}
      <button
        onClick={onNext}
        className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
      >
        {nextLabel}
      </button>
    </div>
  );
}

function WelcomeStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div>
      <StepIndicator current={0} total={4} />
      <div className="mb-2 text-center text-3xl">&#x1F3B2;</div>
      <h2 className="mb-2 text-center text-xl font-bold">Welcome to Competition Mode</h2>
      <p className="mb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        This quick walkthrough will show you how the competition timer works.
        It only takes about 30 seconds.
      </p>
      <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-800/40">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-600 dark:text-amber-400">1</span>
          <span><strong>Inspection</strong> — 15 seconds to study the scramble before solving</span>
        </div>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-600 dark:text-emerald-400">2</span>
          <span><strong>Timer</strong> — Hold Space to arm, release to start, press to stop</span>
        </div>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-xs font-bold text-blue-600 dark:text-blue-400">3</span>
          <span><strong>Submit</strong> — Review your time, apply penalties, confirm each solve</span>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-between">
        <button
          onClick={onSkip}
          className="rounded-lg px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Skip tutorial
        </button>
        <button
          onClick={onNext}
          className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
        >
          Let's go
        </button>
      </div>
    </div>
  );
}

function InspectionStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div>
      <StepIndicator current={1} total={4} />
      <h2 className="mb-2 text-center text-xl font-bold">Inspection Phase</h2>
      <p className="mb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Before each solve, you get 15 seconds to study the scramble.
      </p>
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-900/20">
          <p className="font-medium text-amber-800 dark:text-amber-300">How inspection works:</p>
          <ul className="mt-2 space-y-1 text-amber-700 dark:text-amber-400">
            <li>Press and hold <kbd className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 font-mono text-xs dark:border-amber-800 dark:bg-amber-900/40">Space</kbd> to begin inspection</li>
            <li>A countdown from 15 shows on screen</li>
            <li>At 8 seconds: a yellow warning</li>
            <li>After 15 seconds: automatic +2 penalty</li>
            <li>After 17 seconds: DNF (Did Not Finish)</li>
          </ul>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/40">
          <p className="text-zinc-600 dark:text-zinc-400">
            <strong>Tip:</strong> During inspection, hold Space — you'll see the countdown turn <span className="font-bold text-emerald-500">green</span> when the timer is armed. Release to start solving.
          </p>
        </div>
      </div>
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function TimerDemoStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { snapshot, down, up, reset } = useTimer({ useInspection: true });
  const [triedTimer, setTriedTimer] = useState(false);
  const [penalty, setPenalty] = useState<"none" | "plus2" | "dnf">("none");
  const stoppedRef = useRef(false);

  // The tutorial must teach exactly the real timer — same shared wiring the
  // competition terminal uses (hold Space to arm, release to start, any key
  // stops), not a Space-only subset.
  useTimerControls({ down, up, reset, phase: snapshot.phase });

  useEffect(() => {
    if (snapshot.phase === "stopped" && !stoppedRef.current) {
      stoppedRef.current = true;
      setTriedTimer(true);
      setPenalty("none");
    } else if (snapshot.phase !== "stopped") {
      stoppedRef.current = false;
    }
  }, [snapshot.phase]);

  let timerText = "0.00";
  let timerColor = "text-zinc-400 dark:text-zinc-600";
  if (snapshot.phase === "inspection") {
    const secs = snapshot.inspectionRemainingMs != null ? Math.ceil(snapshot.inspectionRemainingMs / 1000) : 15;
    timerText = String(secs);
    timerColor = secs <= 0 ? "text-red-500" : secs <= 8 ? "text-amber-500" : "text-blue-500";
  } else if (snapshot.phase === "ready") {
    timerText = "0.00";
    timerColor = "text-emerald-500";
  } else if (snapshot.phase === "solving") {
    timerText = formatTime(snapshot.timeMs);
    timerColor = "text-zinc-900 dark:text-white";
  } else if (snapshot.phase === "stopped" && snapshot.result) {
    const raw = snapshot.result.time_ms;
    if (penalty === "dnf") {
      timerText = "DNF";
      timerColor = "text-red-500";
    } else if (penalty === "plus2") {
      timerText = formatTime(raw + 2000) + "+";
      timerColor = "text-orange-400";
    } else {
      timerText = formatTime(raw);
      timerColor = "text-emerald-600 dark:text-emerald-400";
    }
  }

  return (
    <div>
      <StepIndicator current={2} total={4} />
      <h2 className="mb-2 text-center text-xl font-bold">Try the Timer</h2>
      <p className="mb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Press Space to start inspection, hold Space to arm, release to solve, press to stop.
      </p>

      <div className="mb-4 flex flex-col items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 py-8 dark:border-zinc-800 dark:bg-zinc-800/40">
        <div className={`font-mono text-5xl font-bold tabular-nums ${timerColor}`}>
          {timerText}
        </div>
        <p className="text-xs text-zinc-500">
          {snapshot.phase === "idle" && "Press Space to start inspection"}
          {snapshot.phase === "inspection" && "Inspecting... hold Space to arm"}
          {snapshot.phase === "ready" && "Release to start!"}
          {snapshot.phase === "solving" && "Press Space to stop"}
          {snapshot.phase === "stopped" && "Nice! Press Space again to retry"}
        </p>
      </div>

      {snapshot.phase === "stopped" && snapshot.result && (
        <div className="mb-3 flex justify-center">
          <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
            {(["none", "plus2", "dnf"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPenalty(p)}
                className={`px-4 py-1.5 text-sm font-semibold transition ${
                  penalty === p
                    ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {p === "none" ? "OK" : p === "plus2" ? "+2" : "DNF"}
              </button>
            ))}
          </div>
        </div>
      )}

      {triedTimer && (
        <button
          onClick={() => { reset(); setPenalty("none"); }}
          className="mb-2 w-full rounded-lg border border-zinc-300 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-700 dark:border-zinc-700 dark:hover:text-zinc-300"
        >
          Reset timer
        </button>
      )}

      <NavButtons onBack={onBack} onNext={onNext} nextLabel={triedTimer ? "Next" : "Skip demo"} />
    </div>
  );
}

function SubmitDemoStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [penalty, setPenalty] = useState<"none" | "plus2" | "dnf">("none");

  const demoTime = 12340;
  const displayTime =
    penalty === "dnf"
      ? "DNF"
      : penalty === "plus2"
        ? formatTime(demoTime + 2000) + "+"
        : formatTime(demoTime);

  return (
    <div>
      <StepIndicator current={3} total={4} />
      <h2 className="mb-2 text-center text-xl font-bold">Reviewing & Submitting</h2>
      <p className="mb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        After each solve, you can apply penalties before confirming.
      </p>

      <div className="mb-4 space-y-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
        <div className="text-center">
          <div className={`font-mono text-4xl font-bold ${
            penalty === "dnf" ? "text-red-500" : penalty === "plus2" ? "text-orange-400" : "text-emerald-600 dark:text-emerald-400"
          }`}>
            {displayTime}
          </div>
          <p className="mt-1 text-xs text-zinc-500">Example solve: 12.34s</p>
        </div>

        <div className="flex justify-center">
          <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
            {(["none", "plus2", "dnf"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPenalty(p)}
                className={`px-4 py-2 text-sm font-semibold transition ${
                  penalty === p
                    ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {p === "none" ? "OK" : p === "plus2" ? "+2" : "DNF"}
              </button>
            ))}
          </div>
        </div>

        <div className="text-center text-xs text-zinc-500 dark:text-zinc-400">
          Try clicking the penalty buttons above to see how they affect the time
        </div>
      </div>

      <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
        <p><strong>OK</strong> — Time is recorded as-is</p>
        <p><strong>+2</strong> — 2-second penalty added (e.g., misaligned cube face)</p>
        <p><strong>DNF</strong> — Did Not Finish (cube not solved correctly)</p>
      </div>

      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function ReadyStep({ onComplete }: { onComplete: () => void }) {
  return (
    <div>
      <StepIndicator current={4} total={4} />
      <div className="mb-2 text-center text-3xl">&#x2705;</div>
      <h2 className="mb-2 text-center text-xl font-bold">You're Ready!</h2>
      <p className="mb-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
        You now know how the competition timer works. Good luck with your solves!
      </p>
      <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-800/40">
        <p className="font-medium">Quick reference:</p>
        <div className="grid grid-cols-2 gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <span><kbd className="rounded border border-zinc-300 px-1 font-mono dark:border-zinc-700">Space</kbd> Start/Stop</span>
          <span><kbd className="rounded border border-zinc-300 px-1 font-mono dark:border-zinc-700">Esc</kbd> Reset</span>
          <span><kbd className="rounded border border-zinc-300 px-1 font-mono dark:border-zinc-700">D</kbd> Toggle DNF</span>
          <span><kbd className="rounded border border-zinc-300 px-1 font-mono dark:border-zinc-700">P</kbd> Toggle +2</span>
        </div>
      </div>
      <div className="mt-6 flex justify-center">
        <button
          onClick={onComplete}
          className="rounded-lg bg-emerald-600 px-8 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500"
        >
          Start competing
        </button>
      </div>
    </div>
  );
}
