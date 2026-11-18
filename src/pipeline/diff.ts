import type { AuditRun, RawSignal } from "../shared/types.js";
import { fingerprint } from "./fingerprint.js";

export interface RunDiff {
  previousId?: string;
  currentId: string;
  introduced: RawSignal[];
  fixed: RawSignal[];
  persisting: RawSignal[];
}

/** Compara duas execuções pelo fingerprint estável dos sinais. */
export function diffRuns(previous: AuditRun | null, current: AuditRun): RunDiff {
  const previousMap = new Map((previous?.signals ?? []).map((s) => [fingerprint(s), s]));
  const currentMap = new Map(current.signals.map((s) => [fingerprint(s), s]));

  return {
    previousId: previous?.id,
    currentId: current.id,
    introduced: current.signals.filter((signal) => !previousMap.has(fingerprint(signal))),
    fixed: (previous?.signals ?? []).filter((signal) => !currentMap.has(fingerprint(signal))),
    persisting: current.signals.filter((signal) => previousMap.has(fingerprint(signal))),
  };
}
