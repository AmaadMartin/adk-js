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

import {
  AgentDetails,
  AppDetails,
  getDeveloperInstructions,
  getToolsByAgentName,
  InputValidationError,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createAppDetails(
  agentDetails: Record<string, AgentDetails>,
): AppDetails {
  return {agentDetails};
}

describe('app_details', () => {
  it('test_get_developer_instructions_existing_agent', () => {
    const appDetails = createAppDetails({
      agent1: {name: 'agent1', instructions: 'instruction for agent1'},
      agent2: {name: 'agent2', instructions: 'instruction for agent2'},
    });

    expect(getDeveloperInstructions(appDetails, 'agent1')).toBe(
      'instruction for agent1',
    );
  });

  it('test_get_developer_instructions_non_existing_Agent', () => {
    const appDetails = createAppDetails({
      agent1: {name: 'agent1', instructions: 'instruction for agent1'},
      agent2: {name: 'agent2', instructions: 'instruction for agent2'},
    });

    expect(() => getDeveloperInstructions(appDetails, 'agent3')).toThrow(
      new InputValidationError('`agent3` not found in the agentic system.'),
    );
  });

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
  it('reports an agent that declares no instructions as having none', () => {
    const appDetails = createAppDetails({agent1: {name: 'agent1'}});

    expect(getDeveloperInstructions(appDetails, 'agent1')).toBe('');
  });

  it('reports an agent that declares no tools as having none', () => {
    const appDetails = createAppDetails({agent1: {name: 'agent1'}});

    expect(getToolsByAgentName(appDetails)).toEqual({agent1: []});
  });

  it('rejects any agent name when the app names no agent', () => {
    expect(() => getDeveloperInstructions({}, 'agent1')).toThrow(
      InputValidationError,
    );
    expect(getToolsByAgentName({})).toEqual({});
  });

  it('rejects an inherited object property as an agent name', () => {
    const appDetails = createAppDetails({agent1: {name: 'agent1'}});

    expect(() => getDeveloperInstructions(appDetails, 'toString')).toThrow(
      new InputValidationError('`toString` not found in the agentic system.'),
    );
  });
});
