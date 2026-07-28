const MIN_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 8_000;

const lastStartByAccount = new Map<string, number>();

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

async function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function computeWebAccountDelayMs({
  lastStartAt,
  now,
  randomValue,
  minIntervalMs = MIN_INTERVAL_MS,
  maxIntervalMs = MAX_INTERVAL_MS,
}: {
  lastStartAt: number | null;
  now: number;
  randomValue: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
}): number {
  if (lastStartAt == null) return 0;
  const min = Math.max(0, minIntervalMs);
  const max = Math.max(min, maxIntervalMs);
  const boundedRandom = Math.max(0, Math.min(1, randomValue));
  const interval = min + Math.floor((max - min) * boundedRandom);
  return Math.max(0, lastStartAt + interval - now);
}

/**
 * Apply conservative per-account spacing for browser-backed providers.
 * The account semaphore holds concurrency at one while this wait runs.
 */
export async function waitForWebAccountTurn(
  accountKey: string,
  signal?: AbortSignal | null
): Promise<void> {
  const now = Date.now();
  const waitMs = computeWebAccountDelayMs({
    lastStartAt: lastStartByAccount.get(accountKey) ?? null,
    now,
    randomValue: Math.random(),
  });
  await delay(waitMs, signal);
  lastStartByAccount.set(accountKey, Date.now());
}

export function resetWebAccountSchedulerForTesting(): void {
  lastStartByAccount.clear();
}
