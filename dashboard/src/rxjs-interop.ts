import { Signal } from "signal-polyfill";
import { signal } from "@lit-labs/signals";
import { Observable, type Subscription } from "rxjs";

/**
 * Converts an RxJS Observable into a Signal.State.
 * Subscribes immediately — the signal holds `initialValue` until the first emission.
 *
 * Returns a tuple: [signal, teardown] so the caller can unsubscribe.
 * When used inside a SignalWatcher component, call teardown in disconnectedCallback.
 */
export function toSignal<T>(
  obs$: Observable<T>,
  initialValue: T,
): [Signal.State<T>, () => void] {
  const s = signal(initialValue);
  const sub: Subscription = obs$.subscribe((v) => {
    s.set(v);
  });
  return [s, () => sub.unsubscribe()];
}

/**
 * Converts a Signal.State into an RxJS Observable.
 * Uses the TC39 Signal.subtle.Watcher API to react to changes.
 */
export function toObservable<T>(s: Signal.State<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    subscriber.next(s.get());

    const watcher = new Signal.subtle.Watcher(() => {
      // Watcher callback fires synchronously — schedule a microtask
      // to batch and read the current value.
      queueMicrotask(() => {
        watcher.watch();
        subscriber.next(s.get());
      });
    });
    watcher.watch(s);

    return () => watcher.unwatch(s);
  });
}
