/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppDetails,
  NotFoundError,
  getDeveloperInstructions,
  getToolsByAgentName,
} from '@google/adk';
import type {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

const TOOL1: Tool = {
  functionDeclarations: [{name: 'tool1_func'}],
};

const TWO_AGENTS: AppDetails = {
  agentDetails: {
    agent1: {name: 'agent1', instructions: 'instruction for agent1'},
    agent2: {name: 'agent2', instructions: 'instruction for agent2'},
  },
};

describe('getDeveloperInstructions', () => {
  // Ports `test_get_developer_instructions_existing_agent`.
  it('returns the instructions of an existing agent', () => {
    expect(getDeveloperInstructions(TWO_AGENTS, 'agent1')).toBe(
      'instruction for agent1',
    );
    expect(getDeveloperInstructions(TWO_AGENTS, 'agent2')).toBe(
      'instruction for agent2',
    );
  });

  // Ports `test_get_developer_instructions_non_existing_Agent`.
  it('throws for an agent the app does not hold', () => {
    expect(() => getDeveloperInstructions(TWO_AGENTS, 'agent3')).toThrow(
      new NotFoundError('`agent3` not found in the agentic system.'),
    );
  });

  it('throws for an app that declares no agent', () => {
    expect(() => getDeveloperInstructions({}, 'agent1')).toThrow(NotFoundError);
    expect(() =>
      getDeveloperInstructions({agentDetails: {}}, 'agent1'),
    ).toThrow(NotFoundError);
  });

  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'throws for the inherited key %s',
    (inheritedKey) => {
      expect(() => getDeveloperInstructions(TWO_AGENTS, inheritedKey)).toThrow(
        new NotFoundError(
          `\`${inheritedKey}\` not found in the agentic system.`,
        ),
      );
    },
  );

  it('returns an empty string when the agent omits its instructions', () => {
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1'}},
    };

    expect(getDeveloperInstructions(appDetails, 'agent1')).toBe('');
  });

  it('does not mutate the app details', () => {
    const snapshot = structuredClone(TWO_AGENTS);

    getDeveloperInstructions(TWO_AGENTS, 'agent1');
    expect(() => getDeveloperInstructions(TWO_AGENTS, 'agent3')).toThrow(
      NotFoundError,
    );

    expect(TWO_AGENTS).toEqual(snapshot);
  });
});

describe('getToolsByAgentName', () => {
  // Ports `test_get_tools_by_agent_name`.
  it('keeps an entry for an agent that declares no tool', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        agent1: {name: 'agent1', toolDeclarations: [TOOL1]},
        agent2: {name: 'agent2', toolDeclarations: []},
      },
    };

    expect(getToolsByAgentName(appDetails)).toEqual({
      agent1: [TOOL1],
      agent2: [],
    });
  });

  it('returns an empty list when the agent omits its tools', () => {
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1'}},
    };

    expect(getToolsByAgentName(appDetails)).toEqual({agent1: []});
  });

  it('returns an empty map for an app that declares no agent', () => {
    expect(getToolsByAgentName({})).toEqual({});
    expect(getToolsByAgentName({agentDetails: {}})).toEqual({});
  });

  it('returns the declared list by reference, without cloning it', () => {
    const declared = [TOOL1];
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: declared}},
    };

    expect(getToolsByAgentName(appDetails)['agent1']).toBe(declared);
  });

  it('does not mutate the app details', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        agent1: {name: 'agent1', toolDeclarations: [TOOL1]},
        agent2: {name: 'agent2'},
      },
    };
    const snapshot = structuredClone(appDetails);

    getToolsByAgentName(appDetails);

    expect(appDetails).toEqual(snapshot);
  });
});

describe('AppDetails', () => {
  // adk-python aliases these fields to camelCase, so the two SDKs read each
  // other's recorded eval data.
  it('round-trips through JSON with camelCase keys', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        agent1: {
          name: 'agent1',
          instructions: 'instruction for agent1',
          toolDeclarations: [TOOL1],
        },
      },
    };

    const json = JSON.stringify(appDetails);
    expect(JSON.parse(json)).toEqual(appDetails);
    expect(json).toContain('"agentDetails"');
    expect(json).toContain('"instructions"');
    expect(json).toContain('"toolDeclarations"');
    expect(json).toContain('"name"');
  });
});
