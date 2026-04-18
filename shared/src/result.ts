/**
 * Result type — functional error handling.
 * Use Ok() and Err() to construct, match with isOk()/isErr().
 */

export type Result<T, E = Error> = Ok<T> | Err<E>;

export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
};

export type Err<E = Error> = {
  readonly ok: false;
  readonly error: E;
};

export function Ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function Err<E = Error>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwrap a Result, throwing if Err */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error
    ? result.error
    : new Error(String(result.error));
}

/** Map over the success value */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (val: T) => U,
): Result<U, E> {
  if (result.ok) return Ok(fn(result.value));
  return result;
}

/** Wrap an async function that might throw into a Result */
export async function tryCatch<T>(
  fn: () => Promise<T>,
): Promise<Result<T, Error>> {
  try {
    return Ok(await fn());
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Wrap a sync function that might throw into a Result */
export function tryCatchSync<T>(fn: () => T): Result<T, Error> {
  try {
    return Ok(fn());
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)));
  }
}
