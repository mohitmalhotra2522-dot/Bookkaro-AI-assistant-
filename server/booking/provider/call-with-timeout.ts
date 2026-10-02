import type { ProviderCallOptions } from './booking-provider';
import { ProviderTimeoutError } from './booking-provider';

/** Bounded provider call: aborts the signal and rejects with ProviderTimeoutError after timeoutMs. */
export function callWithTimeout<T>(fn: (o: ProviderCallOptions) => Promise<T>, timeoutMs: number): Promise<T> {
  const ac = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { ac.abort(); reject(new ProviderTimeoutError()); }, timeoutMs);
    Promise.resolve().then(() => fn({ signal: ac.signal, timeoutMs })).then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}
