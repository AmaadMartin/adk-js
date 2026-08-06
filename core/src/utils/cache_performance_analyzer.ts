/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cache performance analysis utilities for the ADK context caching system.
 *
 * Provides a read-only helper to analyze cache performance metrics from a
 * session's event history, including hit ratios, cached-vs-total token counts,
 * and cache refresh patterns. It only reads `Event.cacheMetadata` and
 * `Event.usageMetadata`; it never creates or refreshes caches.
 */

import {CacheMetadata} from '../models/cache_metadata.js';
import {BaseSessionService} from '../sessions/base_session_service.js';

import {experimental} from './experimental.js';

/**
 * Cache performance report for an agent that has cache data.
 */
export interface CachePerformanceActiveReport {
  status: 'active';
  /** Number of requests that used caching. */
  requestsWithCache: number;
  /** Average number of invocations each cache was used for. */
  avgInvocationsUsed: number;
  /**
   * `cacheName` of the most recent cache entry (may be undefined when the last
   * entry is fingerprint-only).
   */
  latestCache?: string;
  /** Number of unique cache instances created. */
  cacheRefreshes: number;
  /** Total number of invocations across all caches. */
  totalInvocations: number;
  /** Total prompt tokens across all requests. */
  totalPromptTokens: number;
  /** Total cached content tokens across all requests. */
  totalCachedTokens: number;
  /** Percentage of prompt tokens served from cache. */
  cacheHitRatioPercent: number;
  /** Percentage of requests that had cache hits. */
  cacheUtilizationRatioPercent: number;
  /** Average cached tokens per request. */
  avgCachedTokensPerRequest: number;
  /** Total number of requests processed. */
  totalRequests: number;
  /** Number of requests that had cache hits. */
  requestsWithCacheHits: number;
}

/**
 * Cache performance report for an agent with no cache data.
 */
export interface CachePerformanceNoDataReport {
  status: 'no_cache_data';
}

/**
 * The result of {@link CachePerformanceAnalyzer.analyzeAgentCachePerformance}.
 */
export type CachePerformanceReport =
  | CachePerformanceActiveReport
  | CachePerformanceNoDataReport;

/**
 * Analyzes context-cache performance through a session's event history.
 */
@experimental
export class CachePerformanceAnalyzer {
  constructor(private readonly sessionService: BaseSessionService) {}

  /**
   * Gets the cache usage history for an agent from a session's events.
   *
   * Public so the raw per-event cache metadata can be inspected (and
   * unit-tested) directly, mirroring the reference analyzer's history accessor.
   *
   * @param params.agentName Agent to get history for. When omitted, cache
   *     metadata for all agents is returned.
   * @returns Cache metadata in chronological order, or an empty array when the
   *     session is missing or has no matching cache events.
   */
  async getAgentCacheHistory(params: {
    sessionId: string;
    userId: string;
    appName: string;
    agentName?: string;
  }): Promise<CacheMetadata[]> {
    const {sessionId, userId, appName, agentName} = params;
    const session = await this.sessionService.getSession({
      appName,
      userId,
      sessionId,
    });

    if (!session) {
      return [];
    }

    const cacheHistory: CacheMetadata[] = [];
    for (const event of session.events) {
      if (
        event.cacheMetadata !== undefined &&
        (agentName === undefined || event.author === agentName)
      ) {
        cacheHistory.push(event.cacheMetadata);
      }
    }

    return cacheHistory;
  }

  /**
   * Analyzes cache performance for a single agent.
   *
   * @returns A `no_cache_data` report when the agent has no cache metadata,
   *     otherwise an `active` report with the full set of cache and token
   *     metrics.
   */
  async analyzeAgentCachePerformance(params: {
    sessionId: string;
    userId: string;
    appName: string;
    agentName: string;
  }): Promise<CachePerformanceReport> {
    const {sessionId, userId, appName, agentName} = params;

    const cacheHistory = await this.getAgentCacheHistory({
      sessionId,
      userId,
      appName,
      agentName,
    });

    if (cacheHistory.length === 0) {
      return {status: 'no_cache_data'};
    }

    // Re-fetch for token analysis: getAgentCacheHistory returns only cache
    // metadata, so the events carrying usageMetadata are read here.
    const session = await this.sessionService.getSession({
      appName,
      userId,
      sessionId,
    });
    const events = session?.events ?? [];

    let totalPromptTokens = 0;
    let totalCachedTokens = 0;
    let requestsWithCacheHits = 0;
    let totalRequests = 0;

    for (const event of events) {
      if (event.author === agentName && event.usageMetadata) {
        totalRequests += 1;
        if (event.usageMetadata.promptTokenCount) {
          totalPromptTokens += event.usageMetadata.promptTokenCount;
        }
        if (event.usageMetadata.cachedContentTokenCount) {
          totalCachedTokens += event.usageMetadata.cachedContentTokenCount;
          requestsWithCacheHits += 1;
        }
      }
    }

    const cacheHitRatioPercent =
      totalPromptTokens > 0 ? (totalCachedTokens / totalPromptTokens) * 100 : 0;

    const cacheUtilizationRatioPercent =
      totalRequests > 0 ? (requestsWithCacheHits / totalRequests) * 100 : 0;

    const avgCachedTokensPerRequest =
      totalRequests > 0 ? totalCachedTokens / totalRequests : 0;

    const invocationsUsed = cacheHistory
      .map((c) => c.invocationsUsed)
      .filter((v): v is number => v !== undefined);
    const totalInvocations = invocationsUsed.reduce((sum, v) => sum + v, 0);

    const cacheNames = new Set(
      cacheHistory
        .map((c) => c.cacheName)
        .filter((name): name is string => name !== undefined),
    );

    return {
      status: 'active',
      requestsWithCache: cacheHistory.length,
      avgInvocationsUsed:
        invocationsUsed.length > 0
          ? totalInvocations / invocationsUsed.length
          : 0,
      latestCache: cacheHistory[cacheHistory.length - 1].cacheName,
      cacheRefreshes: cacheNames.size,
      totalInvocations,
      totalPromptTokens,
      totalCachedTokens,
      cacheHitRatioPercent,
      cacheUtilizationRatioPercent,
      avgCachedTokensPerRequest,
      totalRequests,
      requestsWithCacheHits,
    };
  }
}
