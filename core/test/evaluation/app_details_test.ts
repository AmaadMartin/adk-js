/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `ported reference tests` block is a port of `google/adk-python`
 * `tests/unittests/evaluation/test_app_details.py` on `main`. That file holds
 * 3 tests; all 3 are ported here.
 */

import {
  AppDetails,
  getDeveloperInstructions,
  getToolsByAgentName,
} from '@google/adk';
import type {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

const TOOL1: Tool = {
  functionDeclarations: [{name: 'tool1_func'}],
};

function twoInstructedAgents(): AppDetails {
  return {
    agentDetails: {
      agent1: {name: 'agent1', instructions: 'instruction for agent1'},
      agent2: {name: 'agent2', instructions: 'instruction for agent2'},
    },
  };
}

describe('ported reference tests', () => {
  // Ports `test_get_developer_instructions_existing_agent`.
  it('returns the instructions of an existing agent', () => {
    expect(getDeveloperInstructions(twoInstructedAgents(), 'agent1')).toBe(
      'instruction for agent1',
    );
  });

  // Ports `test_get_developer_instructions_non_existing_Agent`.
  it('throws for an agent the app does not hold', () => {
    expect(() =>
      getDeveloperInstructions(twoInstructedAgents(), 'agent3'),
    ).toThrow('`agent3` not found in the agentic system.');
  });

  // Ports `test_get_tools_by_agent_name`.
  it('returns the tools of every agent, keyed by name', () => {
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
});

describe('getDeveloperInstructions', () => {
  it('returns an empty string when the agent declares no instructions', () => {
    const appDetails: AppDetails = {agentDetails: {agent1: {name: 'agent1'}}};

    expect(getDeveloperInstructions(appDetails, 'agent1')).toBe('');
  });

  it('throws when the app declares no agents at all', () => {
    expect(() => getDeveloperInstructions({}, 'agent1')).toThrow(
      '`agent1` not found in the agentic system.',
    );
  });

  it('throws when the agent map is empty', () => {
    expect(() =>
      getDeveloperInstructions({agentDetails: {}}, 'agent1'),
    ).toThrow('`agent1` not found in the agentic system.');
  });

  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'throws for the inherited key %s',
    (inheritedKey) => {
      expect(() =>
        getDeveloperInstructions(twoInstructedAgents(), inheritedKey),
      ).toThrow(`\`${inheritedKey}\` not found in the agentic system.`);
    },
  );

  it('does not mutate the app details it reads', () => {
    const appDetails = twoInstructedAgents();
    const before = structuredClone(appDetails);

    getDeveloperInstructions(appDetails, 'agent1');

    expect(appDetails).toEqual(before);
  });

  it('does not mutate the app details when it throws', () => {
    const appDetails: AppDetails = {};
    const before = structuredClone(appDetails);

    expect(() => getDeveloperInstructions(appDetails, 'agent1')).toThrow();

    expect(appDetails).toEqual(before);
  });
});

describe('getToolsByAgentName', () => {
  it('returns an empty map when the app declares no agents at all', () => {
    expect(getToolsByAgentName({})).toEqual({});
  });

  it('returns an empty map when the agent map is empty', () => {
    expect(getToolsByAgentName({agentDetails: {}})).toEqual({});
  });

  it('returns an empty list for an agent that declares no tools', () => {
    const appDetails: AppDetails = {agentDetails: {agent1: {name: 'agent1'}}};

    expect(getToolsByAgentName(appDetails)).toEqual({agent1: []});
  });

  it('returns the declared list itself, not a copy', () => {
    const declared: Tool[] = [TOOL1];
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: declared}},
    };

    expect(getToolsByAgentName(appDetails)['agent1']).toBe(declared);
  });

  it('does not mutate the app details it reads', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        agent1: {name: 'agent1', toolDeclarations: [TOOL1]},
        agent2: {name: 'agent2'},
      },
    };
    const before = structuredClone(appDetails);

    getToolsByAgentName(appDetails);

    expect(appDetails).toEqual(before);
  });
});

describe('AppDetails serialization', () => {
  // adk-python's `EvalBaseModel` sets `alias_generator=to_camel`, so both SDKs
  // must read the same camelCase keys out of recorded eval data.
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

    const parsed: AppDetails = JSON.parse(JSON.stringify(appDetails));

    expect(getDeveloperInstructions(parsed, 'agent1')).toBe(
      'instruction for agent1',
    );
    expect(getToolsByAgentName(parsed)).toEqual({agent1: [TOOL1]});
  });
});
