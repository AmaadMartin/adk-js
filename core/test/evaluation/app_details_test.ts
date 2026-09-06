/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_app_details.py`. Each `it()` keeps the
 * Python test name, so the two suites stay greppable against each other.
 */

import {AgentDetails, AppDetails, getToolsByAgentName} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createAppDetails(
  agentDetails: Record<string, AgentDetails>,
): AppDetails {
  return {agentDetails};
}

describe('app_details', () => {
  it('test_get_tools_by_agent_name', () => {
    const tool1: Tool = {functionDeclarations: [{name: 'tool1_func'}]};
    const appDetails = createAppDetails({
      agent1: {name: 'agent1', toolDeclarations: [tool1]},
      agent2: {name: 'agent2', toolDeclarations: []},
    });

    expect(getToolsByAgentName(appDetails)).toEqual({
      agent1: [tool1],
      agent2: [],
    });
  });
});

describe('app_details defaults', () => {
  it('reports an agent that declares no tools as having none', () => {
    const appDetails = createAppDetails({agent1: {name: 'agent1'}});

    expect(getToolsByAgentName(appDetails)).toEqual({agent1: []});
  });

  it('reports no tools when the app names no agent', () => {
    expect(getToolsByAgentName({})).toEqual({});
  });
});
