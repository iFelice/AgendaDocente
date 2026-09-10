import { useEffect, useRef, useState } from "react";
import type { SyncPhase, SyncStatus } from "../services/sync/types";

/** Outcome of a manual run triggered from a UI button (transient UI feedback). */
export type ManualOutcome = "idle" | "success" | "error" | "offline";

export interface ManualSyncInput {
  status?: SyncStatus;
  onSyncNow?: () => void;
}

/**
 * Shared manual-sync controller: ONE instance drives every manual trigger
 * (ProfileModal header quick-sync + CloudSync card button) through the SAME
 * `onSyncNow` pipeline (`accountSync.syncNow()` → SyncEngine full cycle with
 * pull/push/reconcile, 3-way merge, Web Lock, coalescing and conflict
 * protection). Sharing the instance — not just the function — also shares the
 * double-trigger guard and the transient outcome feedback, so the header icon
 * and the card button always agree.
 *
 * This hook owns NO sync engine logic: it only tracks "a manual run is in
 * flight" between the click and the engine publishing the end of that cycle,
 * then shows a transient outcome. It never reloads the page, never merges,
 * never touches local data.
 */
export interface ManualSyncController {
  phase: SyncPhase;
  outcome: ManualOutcome;
  /** Button disabled state (identical semantics to the historical card button). */
  disabled: boolean;
  runSync: () => void;
}

export function useManualSync({ status, onSyncNow }: ManualSyncInput): ManualSyncController {
  const phase = status?.phase ?? "disabled";
  const [outcome, setOutcome] = useState<ManualOutcome>("idle");
  /** True between a button click and the engine publishing the end of that cycle. */
  const manualRunRef = useRef(false);

  // Conclude the manual run when the engine publishes a status that is no longer
  // "syncing": every publish emits a fresh status object, so this fires even when a very
  // fast cycle never renders the intermediate "syncing" phase. Success for a completed
  // cycle (idle/awaiting-resolution), explicit failure for error/offline.
  useEffect(() => {
    if (phase === "syncing") return;
    if (!manualRunRef.current) return;
    manualRunRef.current = false;
    setOutcome(phase === "error" ? "error" : phase === "offline" ? "offline" : "success");
  }, [status, phase]);

  // The feedback is transient: back to the neutral label after a few seconds.
  useEffect(() => {
    if (outcome === "idle") return;
    const timer = setTimeout(() => setOutcome("idle"), 4000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const runSync = () => {
    // No double-fire: one manual run at a time; the engine itself coalesces any overlapping
    // request into the running cycle (never two concurrent syncs).
    if (!onSyncNow || manualRunRef.current || phase === "syncing" || phase === "disabled") return;
    manualRunRef.current = true;
    setOutcome("idle");
    onSyncNow();
  };

  return {
    phase,
    outcome,
    disabled: !onSyncNow || phase === "syncing" || phase === "disabled",
    runSync,
  };
}
