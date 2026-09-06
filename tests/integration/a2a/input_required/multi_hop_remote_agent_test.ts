/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RemoteA2AAgentConfig} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const PORT_ENV_VAR = 'TEST_API_SERVER_PORT';

const {agentConfigs} = vi.hoisted(() => ({
  agentConfigs: [] as RemoteA2AAgentConfig[],
}));

// The agent card URL is not publicly readable off a constructed
// RemoteA2AAgent, so record the config the agent module builds it with.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    RemoteA2AAgent: class extends actual.RemoteA2AAgent {
      constructor(config: RemoteA2AAgentConfig) {
        super(config);
        agentConfigs.push(config);
      }
    },
  };
});

/**
 * Re-evaluates the agent module against the currently stubbed environment.
 *
 * The port is read once at module evaluation time, so the module registry has
 * to be reset before every import or later cases reuse the first evaluation.
 */
function importAgentModule() {
  vi.resetModules();
  return import('./test_agents/multi_hop_remote_agent.js');
}

describe('multi_hop_remote_agent', () => {
  beforeEach(() => {
    agentConfigs.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('points the agent card at the port the harness supplied', async () => {
    vi.stubEnv(PORT_ENV_VAR, '41234');

    const {rootAgent} = await importAgentModule();

    expect(rootAgent.name).toBe('multi_hop');
    expect(agentConfigs).toHaveLength(1);
    expect(agentConfigs[0].agentCard).toBe(
      'http://localhost:41234/a2a/multi_hop/',
    );
  });

  it.each([undefined, ''])(
    'throws a "not set" error when the port is %j',
    async (raw) => {
      vi.stubEnv(PORT_ENV_VAR, raw);

      await expect(importAgentModule()).rejects.toThrow(
        `${PORT_ENV_VAR} is not set.`,
      );
    },
  );

  it.each(['abc', '41234abc', '0', '-1', '1.5', '   '])(
    'throws a "positive integer" error when the port is %j',
    async (raw) => {
      vi.stubEnv(PORT_ENV_VAR, raw);

      await expect(importAgentModule()).rejects.toThrow(
        `${PORT_ENV_VAR} must be a positive integer, got "${raw}".`,
      );
    },
  );
});
