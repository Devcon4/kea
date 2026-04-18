import { describe, it, expect } from "vitest";
import { toSignal, toObservable } from "./rxjs-interop.js";
import { signal } from "@lit-labs/signals";
import { BehaviorSubject, Subject, firstValueFrom, take, toArray } from "rxjs";

describe("rxjs-interop", () => {
  describe("toSignal", () => {
    it("should initialize with the provided initial value", () => {
      const subject = new Subject<number>();
      const [s, teardown] = toSignal(subject, 42);

      expect(s.get()).toBe(42);
      teardown();
    });

    it("should update the signal when the observable emits", () => {
      const subject = new BehaviorSubject<string>("hello");
      const [s, teardown] = toSignal(subject, "default");

      expect(s.get()).toBe("hello");

      subject.next("world");
      expect(s.get()).toBe("world");

      teardown();
    });

    it("should stop updating after teardown", () => {
      const subject = new BehaviorSubject<number>(1);
      const [s, teardown] = toSignal(subject, 0);

      expect(s.get()).toBe(1);
      teardown();

      subject.next(99);
      expect(s.get()).toBe(1);
    });

    it("should handle multiple emissions", () => {
      const subject = new Subject<number>();
      const [s, teardown] = toSignal(subject, 0);

      subject.next(1);
      subject.next(2);
      subject.next(3);

      expect(s.get()).toBe(3);
      teardown();
    });
  });

  describe("toObservable", () => {
    it("should emit the current signal value immediately", async () => {
      const s = signal(10);

      const value = await firstValueFrom(toObservable(s));
      expect(value).toBe(10);
    });

    it("should emit when the signal value changes", async () => {
      const s = signal("a");

      const values$ = toObservable(s).pipe(take(2), toArray());
      const valuesPromise = firstValueFrom(values$);

      // Change the signal after a tick
      queueMicrotask(() => {
        s.set("b");
      });

      const values = await valuesPromise;
      expect(values).toEqual(["a", "b"]);
    });
  });
});
