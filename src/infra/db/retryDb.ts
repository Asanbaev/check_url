import { logger } from "../logging/logger";

const defaultRetryDelaysMs = [0, 500, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function isRetryableDbError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return includesAny(text, [
    "sequelizeconnectionerror",
    "sequelizetimeouterror",
    "connectionacquiretimeouterror",
    "etimedout",
    "econnreset",
    "econnrefused",
    "ehostunreach",
    "enotfound",
    "protocol_connection_lost",
    "deadlock",
    "lock wait timeout"
  ]);
}

export async function withDbRetry<T>(operation: string, run: () => Promise<T>, retryDelaysMs = defaultRetryDelaysMs): Promise<T> {
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < retryDelaysMs.length; attemptIndex += 1) {
    const delayMs = retryDelaysMs[attemptIndex];
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await run();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableDbError(error);
      logger.error("db retry attempt failed", {
        operation,
        attempt: attemptIndex + 1,
        maxAttempts: retryDelaysMs.length,
        delayBeforeAttemptMs: delayMs,
        retryable,
        error: String(error)
      });
      if (!retryable) {
        throw error;
      }
    }
  }

  logger.error("db retry exhausted", {
    operation,
    maxAttempts: retryDelaysMs.length,
    error: String(lastError)
  });
  throw lastError;
}