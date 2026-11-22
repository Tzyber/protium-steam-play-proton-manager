export interface LatestGuard {
  begin(): () => boolean;
  cancel(): void;
}

/** Zähler für asynchrone Aufträge: jeder neue Start oder `cancel()` macht
 *  frühere Checks ungültig, ohne interne Sequenznummern preiszugeben. */
export function latest(): LatestGuard {
  let seq = 0;
  return {
    begin() {
      const id = ++seq;
      return () => id === seq;
    },
    cancel() {
      ++seq;
    },
  };
}
