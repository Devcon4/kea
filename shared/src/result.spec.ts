import { describe, it, expect } from "vitest";
import {
  Ok,
  Err,
  isOk,
  isErr,
  unwrap,
  mapResult,
  tryCatch,
  tryCatchSync,
} from "./result.js";

describe("Result", () => {
  it("Ok should create a success result", () => {
    const r = Ok(42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it("Err should create a failure result", () => {
    const r = Err(new Error("boom"));
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe("boom");
  });

  it("isOk and isErr should narrow correctly", () => {
    const ok = Ok("hello");
    const err = Err(new Error("fail"));

    expect(isOk(ok)).toBe(true);
    expect(isErr(ok)).toBe(false);
    expect(isOk(err)).toBe(false);
    expect(isErr(err)).toBe(true);
  });

  it("unwrap should return value for Ok", () => {
    expect(unwrap(Ok(99))).toBe(99);
  });

  it("unwrap should throw for Err", () => {
    expect(() => unwrap(Err(new Error("nope")))).toThrow("nope");
  });

  it("mapResult should transform Ok values", () => {
    const r = mapResult(Ok(5), (n) => n * 2);
    expect(isOk(r) && r.value).toBe(10);
  });

  it("mapResult should pass through Err", () => {
    const r = mapResult(Err(new Error("e")), (n: number) => n * 2);
    expect(isErr(r) && r.error.message).toBe("e");
  });

  it("tryCatchSync should catch throws", () => {
    const r = tryCatchSync(() => {
      throw new Error("sync boom");
    });
    expect(isErr(r) && r.error.message).toBe("sync boom");
  });

  it("tryCatchSync should return Ok on success", () => {
    const r = tryCatchSync(() => 42);
    expect(isOk(r) && r.value).toBe(42);
  });

  it("tryCatch should handle async success", async () => {
    const r = await tryCatch(async () => "async ok");
    expect(isOk(r) && r.value).toBe("async ok");
  });

  it("tryCatch should handle async failure", async () => {
    const r = await tryCatch(async () => {
      throw new Error("async boom");
    });
    expect(isErr(r) && r.error.message).toBe("async boom");
  });
});
