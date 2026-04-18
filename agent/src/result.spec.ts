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
import type { Result } from "./result.js";

describe("Ok", () => {
  it("creates a success result", () => {
    const result = Ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it("holds complex values", () => {
    const data = { name: "kea", items: [1, 2, 3] };
    const result = Ok(data);
    expect(result.value).toEqual(data);
  });

  it("holds undefined", () => {
    const result = Ok(undefined);
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });
});

describe("Err", () => {
  it("creates an error result", () => {
    const result = Err(new Error("boom"));
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("boom");
  });

  it("holds string errors", () => {
    const result = Err("oops");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("oops");
  });
});

describe("isOk", () => {
  it("returns true for Ok", () => {
    expect(isOk(Ok("hello"))).toBe(true);
  });

  it("returns false for Err", () => {
    expect(isOk(Err(new Error("no")))).toBe(false);
  });

  it("narrows type in conditional", () => {
    const result: Result<number> = Ok(10);
    if (isOk(result)) {
      expect(result.value).toBe(10);
    }
  });
});

describe("isErr", () => {
  it("returns true for Err", () => {
    expect(isErr(Err(new Error("fail")))).toBe(true);
  });

  it("returns false for Ok", () => {
    expect(isErr(Ok(1))).toBe(false);
  });

  it("narrows type in conditional", () => {
    const result: Result<number> = Err(new Error("bad"));
    if (isErr(result)) {
      expect(result.error.message).toBe("bad");
    }
  });
});

describe("unwrap", () => {
  it("returns value for Ok", () => {
    expect(unwrap(Ok(99))).toBe(99);
  });

  it("throws for Err with Error instance", () => {
    expect(() => unwrap(Err(new Error("nope")))).toThrow("nope");
  });

  it("wraps non-Error values in Error when throwing", () => {
    expect(() => unwrap(Err("string error"))).toThrow("string error");
  });
});

describe("mapResult", () => {
  it("transforms success value", () => {
    const result = mapResult(Ok(5), (n) => n * 2);
    expect(result).toEqual(Ok(10));
  });

  it("passes through Err unchanged", () => {
    const err = Err(new Error("nope"));
    const result = mapResult(err, (_n: never) => 999);
    expect(result).toBe(err);
  });

  it("changes result type", () => {
    const result = mapResult(Ok(42), (n) => String(n));
    expect(result).toEqual(Ok("42"));
  });
});

describe("tryCatch", () => {
  it("wraps successful async function in Ok", async () => {
    const result = await tryCatch(async () => 42);
    expect(result).toEqual(Ok(42));
  });

  it("wraps thrown Error in Err", async () => {
    const result = await tryCatch(async () => {
      throw new Error("async boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("async boom");
    }
  });

  it("wraps thrown non-Error in Err with string coercion", async () => {
    const result = await tryCatch(async () => {
      throw "raw string";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("raw string");
    }
  });

  it("handles rejected promises", async () => {
    const result = await tryCatch(() => Promise.reject(new Error("rejected")));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("rejected");
    }
  });
});

describe("tryCatchSync", () => {
  it("wraps successful sync function in Ok", () => {
    const result = tryCatchSync(() => 100);
    expect(result).toEqual(Ok(100));
  });

  it("wraps thrown Error in Err", () => {
    const result = tryCatchSync(() => {
      throw new Error("sync boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("sync boom");
    }
  });

  it("wraps thrown non-Error in Err with string coercion", () => {
    const result = tryCatchSync(() => {
      throw 404;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("404");
    }
  });
});
