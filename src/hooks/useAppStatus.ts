import { useEffect, useState } from 'react';

/**
 * Read-only capability snapshot from the EXISTING GET /api/health endpoint.
 * Used only to label the UI honestly (live vs development data). Nothing is
 * claimed while it is unknown, and nothing is claimed if the call fails.
 */
export interface AppStatus {
  state: 'loading' | 'ok' | 'unavailable';
  /** 'REAL' = live railway providers, 'MOCK' = development data. */
  railwayKind: 'REAL' | 'MOCK' | null;
  llmConfigured: boolean;
  llmMock: boolean;
  realBookingEnabled: boolean | null;
  /** P42: Same Train Alternative tool enabled on the server (feature flag). */
  sameTrainAlternatives: boolean;
}

const INITIAL: AppStatus = { state: 'loading', railwayKind: null, llmConfigured: false, llmMock: false, realBookingEnabled: null, sameTrainAlternatives: false };

export function useAppStatus(): AppStatus {
  const [status, setStatus] = useState<AppStatus>(INITIAL);
  useEffect(() => {
    let live = true;
    fetch('/api/health')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then((h: any) => {
        if (!live) return;
        const kind = h?.providerKind === 'REAL' ? 'REAL' : h?.providerKind === 'MOCK' ? 'MOCK' : null;
        const llmId = String(h?.llm?.providerId || '');
        setStatus({
          state: 'ok',
          railwayKind: kind,
          llmConfigured: !!h?.llm?.configured,
          llmMock: /mock/i.test(llmId),
          realBookingEnabled: typeof h?.executionCapability?.realBookingEnabled === 'boolean' ? h.executionCapability.realBookingEnabled : null,
          sameTrainAlternatives: h?.sameTrainAlternatives?.enabled === true
        });
      })
      .catch(() => { if (live) setStatus({ ...INITIAL, state: 'unavailable' }); });
    return () => { live = false; };
  }, []);
  return status;
}
