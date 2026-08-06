/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  CacheMetadata,
  CachePerformanceActiveReport,
  CachePerformanceAnalyzer,
  Event,
  InMemorySessionService,
  Session,
  createEvent,
} from '@google/adk';
import {GenerateContentResponseUsageMetadata} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** Creates a session service whose `getSession` resolves to `session`. */
function createFakeSessionService(session: Session | undefined) {
  const getSession = vi.fn().mockResolvedValue(session);
  return {service: {getSession} as unknown as BaseSessionService, getSession};
}

/** Builds an active-cache `CacheMetadata` literal. */
function createCacheMetadata(
  invocationsUsed: number,
  cacheName = 'test-cache',
  contentsCount = 5,
): CacheMetadata {
  return {
    cacheName: `projects/test/locations/us-central1/cachedContents/${cacheName}`,
    expireTime: Date.now() / 1000 + 1800,
    fingerprint: 'test_fingerprint',
    invocationsUsed,
    contentsCount,
    createdAt: Date.now() / 1000 - 600,
  };
}

/** Builds a `GenerateContentResponseUsageMetadata` literal. */
function createUsageMetadata(
  promptTokens?: number,
  cachedTokens?: number,
): GenerateContentResponseUsageMetadata {
  return {
    promptTokenCount: promptTokens,
    cachedContentTokenCount: cachedTokens,
    candidatesTokenCount: 100,
    totalTokenCount: (promptTokens ?? 0) + 100,
  };
}

/** Builds an `Event` with only the fields the analyzer reads. */
function mockEvent(
  author: string,
  cacheMetadata?: CacheMetadata,
  usageMetadata?: GenerateContentResponseUsageMetadata,
): Event {
  return {
    author,
    cacheMetadata,
    usageMetadata,
    timestamp: Date.now(),
  } as unknown as Event;
}

/** Builds a `Session` wrapping the given events. */
function createTestSession(events: Event[]): Session {
  return {
    id: 'test_session',
    appName: 'test_app',
    userId: 'test_user',
    state: {},
    events,
    lastUpdateTime: 0,
  };
}

const LOOKUP = {
  sessionId: 'test_session',
  userId: 'test_user',
  appName: 'test_app',
};

describe('CachePerformanceAnalyzer', () => {
  let analyzer: CachePerformanceAnalyzer;
  let getSession: ReturnType<typeof vi.fn>;

  function useSession(session: Session | undefined): void {
    const fake = createFakeSessionService(session);
    getSession = fake.getSession;
    analyzer = new CachePerformanceAnalyzer(fake.service);
  }

  beforeEach(() => {
    useSession(createTestSession([]));
  });

  it('stores the injected session service and uses it', async () => {
    await analyzer.getAgentCacheHistory({...LOOKUP, agentName: 'test_agent'});
    expect(getSession).toHaveBeenCalledWith(LOOKUP);
  });

  describe('getAgentCacheHistory', () => {
    it('returns [] for an empty session', async () => {
      useSession(createTestSession([]));
      const result = await analyzer.getAgentCacheHistory({
        ...LOOKUP,
        agentName: 'test_agent',
      });
      expect(result).toEqual([]);
    });

    it('returns [] when no events have cache metadata', async () => {
      useSession(
        createTestSession([
          mockEvent('test_agent'),
          mockEvent('other_agent'),
          mockEvent('test_agent'),
        ]),
      );
      const result = await analyzer.getAgentCacheHistory({
        ...LOOKUP,
        agentName: 'test_agent',
      });
      expect(result).toEqual([]);
    });

    it('returns cache metadata for a specific agent, in order', async () => {
      const cache1 = createCacheMetadata(1, 'cache1');
      const cache2 = createCacheMetadata(3, 'cache2');
      const cache3 = createCacheMetadata(5, 'cache3');
      useSession(
        createTestSession([
          mockEvent('test_agent', cache1),
          mockEvent('other_agent', cache2),
          mockEvent('test_agent', cache3),
          mockEvent('test_agent'),
        ]),
      );

      const result = await analyzer.getAgentCacheHistory({
        ...LOOKUP,
        agentName: 'test_agent',
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(cache1);
      expect(result[1]).toBe(cache3);
    });

    it('returns cache metadata for all agents when agentName is omitted', async () => {
      const cache1 = createCacheMetadata(1, 'cache1');
      const cache2 = createCacheMetadata(3, 'cache2');
      useSession(
        createTestSession([
          mockEvent('agent1', cache1),
          mockEvent('agent2', cache2),
          mockEvent('agent1'),
        ]),
      );

      const result = await analyzer.getAgentCacheHistory({...LOOKUP});

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(cache1);
      expect(result[1]).toBe(cache2);
    });
  });

  describe('analyzeAgentCachePerformance', () => {
    it('returns no_cache_data when there is no cache data', async () => {
      useSession(createTestSession([]));
      const result = await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      });
      expect(result).toEqual({status: 'no_cache_data'});
    });

    it('computes a full report across multiple caches', async () => {
      const cache1 = createCacheMetadata(2, 'cache1');
      const cache2 = createCacheMetadata(5, 'cache2');
      const cache3 = createCacheMetadata(8, 'cache3');
      useSession(
        createTestSession([
          mockEvent('test_agent', cache1, createUsageMetadata(1000, 800)),
          mockEvent('other_agent', cache2),
          mockEvent('test_agent', cache2, createUsageMetadata(1500, 1200)),
          mockEvent('test_agent', cache3, createUsageMetadata(800, 0)),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.requestsWithCache).toBe(3);
      expect(result.cacheRefreshes).toBe(3);
      expect(result.totalInvocations).toBe(15);
      expect(result.avgInvocationsUsed).toBe((2 + 5 + 8) / 3);

      expect(result.totalPromptTokens).toBe(3300);
      expect(result.totalCachedTokens).toBe(2000);
      expect(result.totalRequests).toBe(3);
      expect(result.requestsWithCacheHits).toBe(2);

      expect(result.cacheHitRatioPercent).toBeCloseTo((2000 / 3300) * 100, 2);
      expect(result.cacheUtilizationRatioPercent).toBeCloseTo((2 / 3) * 100, 2);
      expect(result.avgCachedTokensPerRequest).toBeCloseTo(2000 / 3, 2);
    });

    it('computes a report for a single cache', async () => {
      const cache = createCacheMetadata(10, 'single_cache');
      useSession(
        createTestSession([
          mockEvent('test_agent', cache, createUsageMetadata(2000, 1500)),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.requestsWithCache).toBe(1);
      expect(result.avgInvocationsUsed).toBe(10);
      expect(result.cacheRefreshes).toBe(1);
      expect(result.totalInvocations).toBe(10);
      expect(result.latestCache).toBe(cache.cacheName);

      expect(result.totalPromptTokens).toBe(2000);
      expect(result.totalCachedTokens).toBe(1500);
      expect(result.cacheHitRatioPercent).toBe(75);
      expect(result.cacheUtilizationRatioPercent).toBe(100);
      expect(result.avgCachedTokensPerRequest).toBe(1500);
    });

    it('returns zero token metrics when events have no usage metadata', async () => {
      useSession(
        createTestSession([mockEvent('test_agent', createCacheMetadata(5))]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.requestsWithCache).toBe(1);
      expect(result.totalPromptTokens).toBe(0);
      expect(result.totalCachedTokens).toBe(0);
      expect(result.cacheHitRatioPercent).toBe(0);
      expect(result.cacheUtilizationRatioPercent).toBe(0);
      expect(result.avgCachedTokensPerRequest).toBe(0);
    });

    it('handles caches with zero invocations', async () => {
      const cache = createCacheMetadata(0, 'zero_cache');
      useSession(
        createTestSession([
          mockEvent('test_agent', cache, createUsageMetadata(1000, 500)),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.avgInvocationsUsed).toBe(0);
      expect(result.totalInvocations).toBe(0);
      expect(result.totalPromptTokens).toBe(1000);
      expect(result.totalCachedTokens).toBe(500);
    });

    it('calls getSession twice with the correct parameters', async () => {
      const integrationLookup = {
        sessionId: 'integration_session',
        userId: 'integration_user',
        appName: 'integration_app',
      };
      useSession(
        createTestSession([
          mockEvent('integration_agent', createCacheMetadata(7)),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...integrationLookup,
        agentName: 'integration_agent',
      })) as CachePerformanceActiveReport;

      expect(getSession).toHaveBeenCalledTimes(2);
      expect(getSession).toHaveBeenLastCalledWith(integrationLookup);
      expect(result.status).toBe('active');
      expect(result.requestsWithCache).toBe(1);
    });

    it('handles fingerprint-only entries without crashing', async () => {
      const fpOnly: CacheMetadata = {fingerprint: 'fp', contentsCount: 3};
      const active = createCacheMetadata(4, 'active');
      useSession(
        createTestSession([
          mockEvent('test_agent', fpOnly, createUsageMetadata(1000, 0)),
          mockEvent('test_agent', active, createUsageMetadata(1000, 800)),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.totalRequests).toBe(2);
      expect(result.totalPromptTokens).toBe(2000);
      expect(result.totalCachedTokens).toBe(800);
      expect(result.totalInvocations).toBe(4);
      expect(result.avgInvocationsUsed).toBe(4);
      expect(result.cacheRefreshes).toBe(1);
      expect(result.requestsWithCache).toBe(2);
    });

    it('filters strictly by agent name', async () => {
      const targetCache = createCacheMetadata(3, 'target');
      const otherCache = createCacheMetadata(5, 'other');
      useSession(
        createTestSession([
          mockEvent(
            'target_agent',
            targetCache,
            createUsageMetadata(1000, 800),
          ),
          mockEvent('other_agent', otherCache, createUsageMetadata(2000, 1600)),
          mockEvent('target_agent'),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'target_agent',
      })) as CachePerformanceActiveReport;

      expect(result.requestsWithCache).toBe(1);
      expect(result.totalInvocations).toBe(3);
      expect(result.totalPromptTokens).toBe(1000);
      expect(result.totalCachedTokens).toBe(800);
    });

    it('leaves latestCache undefined for a fingerprint-only history', async () => {
      const fpOnly: CacheMetadata = {fingerprint: 'fp', contentsCount: 3};
      useSession(
        createTestSession([
          mockEvent('test_agent', fpOnly, createUsageMetadata(1000, 0)),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.latestCache).toBeUndefined();
      expect(result.avgInvocationsUsed).toBe(0);
      expect(result.totalInvocations).toBe(0);
      expect(result.cacheRefreshes).toBe(0);
      expect(result.requestsWithCache).toBe(1);
      expect(result.totalPromptTokens).toBe(1000);
    });

    it('ignores prompt tokens when promptTokenCount is falsy', async () => {
      useSession(
        createTestSession([
          mockEvent(
            'test_agent',
            createCacheMetadata(2),
            createUsageMetadata(0, 0),
          ),
        ]),
      );

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.totalRequests).toBe(1);
      expect(result.totalPromptTokens).toBe(0);
      expect(result.totalCachedTokens).toBe(0);
      expect(result.requestsWithCacheHits).toBe(0);
    });
  });

  describe('adk-js adaptations', () => {
    it('treats an undefined session as no cache data', async () => {
      useSession(undefined);

      const history = await analyzer.getAgentCacheHistory({
        ...LOOKUP,
        agentName: 'test_agent',
      });
      expect(history).toEqual([]);

      const result = await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      });
      expect(result).toEqual({status: 'no_cache_data'});
    });

    it('treats an undefined second fetch as having no events', async () => {
      const session = createTestSession([
        mockEvent('test_agent', createCacheMetadata(3)),
      ]);
      getSession = vi
        .fn()
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(undefined);
      analyzer = new CachePerformanceAnalyzer({
        getSession,
      } as unknown as BaseSessionService);

      const result = (await analyzer.analyzeAgentCachePerformance({
        ...LOOKUP,
        agentName: 'test_agent',
      })) as CachePerformanceActiveReport;

      expect(result.status).toBe('active');
      expect(result.requestsWithCache).toBe(1);
      expect(result.totalInvocations).toBe(3);
      expect(result.totalRequests).toBe(0);
      expect(result.totalPromptTokens).toBe(0);
      expect(result.totalCachedTokens).toBe(0);
    });
  });

  // End-to-end coverage against the real InMemorySessionService (no mocks):
  // create a session, append real events carrying cacheMetadata / usageMetadata,
  // then analyze the persisted history.
  describe('end-to-end with InMemorySessionService', () => {
    const APP = 'app-1';
    const USER = 'user-1';
    const AGENT = 'research_agent';

    it('analyzes a session persisted through the real service', async () => {
      const service = new InMemorySessionService();
      const session = await service.createSession({
        appName: APP,
        userId: USER,
      });
      const e2eAnalyzer = new CachePerformanceAnalyzer(service);

      const cacheA = createCacheMetadata(3, 'a');
      const cacheB = createCacheMetadata(6, 'b');

      await service.appendEvent({
        session,
        event: createEvent({
          author: AGENT,
          cacheMetadata: cacheA,
          usageMetadata: createUsageMetadata(1000, 600),
        }),
      });
      await service.appendEvent({
        session,
        event: createEvent({
          author: 'other_agent',
          cacheMetadata: createCacheMetadata(9, 'other'),
          usageMetadata: createUsageMetadata(5000, 4000),
        }),
      });
      await service.appendEvent({
        session,
        event: createEvent({
          author: AGENT,
          cacheMetadata: cacheB,
          usageMetadata: createUsageMetadata(2000, 1000),
        }),
      });
      await service.appendEvent({
        session,
        event: createEvent({author: AGENT}),
      });

      const history = await e2eAnalyzer.getAgentCacheHistory({
        sessionId: session.id,
        userId: USER,
        appName: APP,
        agentName: AGENT,
      });
      expect(history).toEqual([cacheA, cacheB]);

      const report = (await e2eAnalyzer.analyzeAgentCachePerformance({
        sessionId: session.id,
        userId: USER,
        appName: APP,
        agentName: AGENT,
      })) as CachePerformanceActiveReport;

      expect(report.status).toBe('active');
      expect(report.requestsWithCache).toBe(2);
      expect(report.cacheRefreshes).toBe(2);
      expect(report.totalInvocations).toBe(9);
      expect(report.avgInvocationsUsed).toBe(4.5);
      expect(report.latestCache).toBe(cacheB.cacheName);
      expect(report.totalRequests).toBe(2);
      expect(report.totalPromptTokens).toBe(3000);
      expect(report.totalCachedTokens).toBe(1600);
      expect(report.requestsWithCacheHits).toBe(2);
      expect(report.cacheHitRatioPercent).toBeCloseTo((1600 / 3000) * 100, 2);
      expect(report.cacheUtilizationRatioPercent).toBe(100);
      expect(report.avgCachedTokensPerRequest).toBe(800);
    });

    it('returns no_cache_data for a real session with no cache events', async () => {
      const service = new InMemorySessionService();
      const session = await service.createSession({
        appName: APP,
        userId: USER,
      });
      const e2eAnalyzer = new CachePerformanceAnalyzer(service);

      await service.appendEvent({
        session,
        event: createEvent({
          author: AGENT,
          usageMetadata: createUsageMetadata(100, 0),
        }),
      });

      const report = await e2eAnalyzer.analyzeAgentCachePerformance({
        sessionId: session.id,
        userId: USER,
        appName: APP,
        agentName: AGENT,
      });
      expect(report).toEqual({status: 'no_cache_data'});
    });
  });
});
