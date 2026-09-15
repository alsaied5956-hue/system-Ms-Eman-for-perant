/**
 * src/utils/promiseTimeout.ts
 * Cloud Timeout Guard: Wraps any promise with an explicit timeout (default: 10 seconds).
 * Prevents infinite loaders when network drops or cloud backend fails to respond.
 */

export class TimeoutError extends Error {
  constructor(message = "Network connection error. Request timed out after 10 seconds") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Wraps a promise with a timeout (default 10,000ms = 10s).
 * If the promise does not settle within `timeoutMs`, rejects with a TimeoutError.
 */
export function withTimeout<T>(
  promise: PromiseLike<T> | Promise<T>,
  timeoutMs: number = 10000,
  errorMessage: string = "انتهت مهلة الاتصال بالخادم السحابي (10 ثوانٍ)"
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([
    Promise.resolve(promise).then((res) => {
      if (timer) clearTimeout(timer);
      return res;
    }),
    timeoutPromise,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
