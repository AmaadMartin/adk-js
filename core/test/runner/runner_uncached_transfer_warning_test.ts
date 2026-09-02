/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  ContextCacheConfig,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 5,
  ttlSeconds: 600,
  minTokens: 1024,
};

function agent(name: string, subAgents: BaseAgent[] = []): LlmAgent {
  return new LlmAgent({name, model: 'gemini-2.5-flash', subAgents});
}

function buildRunner(
  appName: string,
  options: {multiAgent: boolean; contextCacheConfig?: ContextCacheConfig},
): Runner {
  const rootAgent = options.multiAgent
    ? agent('root', [agent('child')])
    : agent('root');
  return new Runner({
    app: new App({
      name: appName,
      rootAgent,
      contextCacheConfig: options.contextCacheConfig,
    }),
    sessionService: new InMemorySessionService(),
  });
}

/** The warnings that name the missing context cache config. */
function cacheWarnings(warn: {mock: {calls: unknown[][]}}): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('contextCacheConfig'));
}

// Each case uses its own app name: the warning fires once per app name for the
// lifetime of the process, so a shared name would leak between tests.
describe('uncached agent transfer warning', () => {
  it('warns when a transfer-capable app has no context cache', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    buildRunner('uncached_multi_app', {multiAgent: true});

    const warnings = cacheWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('uncached_multi_app');
    expect(warnings[0]).toContain('can transfer between agents');
  });

  it('stays quiet when the app configures a context cache', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    buildRunner('cached_multi_app', {
      multiAgent: true,
      contextCacheConfig: CACHE_CONFIG,
    });

    expect(cacheWarnings(warn)).toEqual([]);
  });

  it('stays quiet for an app that cannot transfer', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    buildRunner('single_agent_app', {multiAgent: false});

    expect(cacheWarnings(warn)).toEqual([]);
  });

  it('warns once however many runners the app builds', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    buildRunner('repeated_app', {multiAgent: true});
    buildRunner('repeated_app', {multiAgent: true});
    buildRunner('repeated_app', {multiAgent: true});

    expect(cacheWarnings(warn)).toHaveLength(1);
  });
});
