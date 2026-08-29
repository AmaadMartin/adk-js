/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AppDetails} from '@google/adk';
import {
  NotFoundError,
  getDeveloperInstructions,
  getToolsByAgentName,
} from '@google/adk';
import type {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

const TOOL1: Tool = {functionDeclarations: [{name: 'tool1_func'}]};

function createTwoAgentApp(): AppDetails {
  return {
    agentDetails: {
      agent1: {name: 'agent1', instructions: 'instruction for agent1'},
      agent2: {name: 'agent2', instructions: 'instruction for agent2'},
    },
  };
}

describe('getDeveloperInstructions', () => {
  it('returns the instructions of an existing agent', () => {
    expect(getDeveloperInstructions(createTwoAgentApp(), 'agent1')).toBe(
      'instruction for agent1',
    );
  });

  it('throws for an agent the app does not hold', () => {
    const appDetails = createTwoAgentApp();

    expect(() => getDeveloperInstructions(appDetails, 'agent3')).toThrow(
      NotFoundError,
    );
    expect(() => getDeveloperInstructions(appDetails, 'agent3')).toThrow(
      '`agent3` not found in the agentic system.',
    );
  });

  // A truthiness test would resolve these through `Object.prototype` and
  // return `undefined` instead of throwing.
  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'throws for the inherited key %s',
    (agentName) => {
      expect(() => getDeveloperInstructions(createTwoAgentApp(), agentName)) //
        .toThrow(NotFoundError);
    },
  );

  it('throws when the app holds no agent at all', () => {
    expect(() => getDeveloperInstructions({}, 'agent1')).toThrow(NotFoundError);
    expect(() => getDeveloperInstructions({agentDetails: {}}, 'agent1')) //
      .toThrow(NotFoundError);
  });

  it('returns an empty string when the agent omits its instructions', () => {
    const appDetails: AppDetails = {agentDetails: {agent1: {name: 'agent1'}}};

    expect(getDeveloperInstructions(appDetails, 'agent1')).toBe('');
  });
});

describe('getToolsByAgentName', () => {
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

  it('returns the declared tool list by reference', () => {
    const toolDeclarations = [TOOL1];
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations}},
    };

    expect(getToolsByAgentName(appDetails)['agent1']).toBe(toolDeclarations);
  });

  it('returns an empty list when the agent omits its tools', () => {
    const appDetails: AppDetails = {agentDetails: {agent1: {name: 'agent1'}}};

    expect(getToolsByAgentName(appDetails)).toEqual({agent1: []});
  });

  it('returns an empty object when the app holds no agent at all', () => {
    expect(getToolsByAgentName({})).toEqual({});
    expect(getToolsByAgentName({agentDetails: {}})).toEqual({});
  });
});

describe('AppDetails', () => {
  it('is not mutated by either accessor', () => {
    const appDetails = createTwoAgentApp();
    const snapshot = structuredClone(appDetails);

    getDeveloperInstructions(appDetails, 'agent1');
    getToolsByAgentName(appDetails);

    expect(appDetails).toEqual(snapshot);
  });

  // adk-python aliases these fields to camelCase, so the JSON form is the
  // cross-language contract.
  it('round-trips through JSON with the adk-python field names', () => {
    const appDetails: Required<AppDetails> = {
      agentDetails: {
        agent1: {
          name: 'agent1',
          instructions: 'instruction for agent1',
          toolDeclarations: [TOOL1],
        },
      },
    };

    const parsed = JSON.parse(
      JSON.stringify(appDetails),
    ) as Required<AppDetails>;

    expect(parsed).toEqual(appDetails);
    expect(Object.keys(parsed)).toEqual(['agentDetails']);
    expect(Object.keys(parsed.agentDetails['agent1'])).toEqual([
      'name',
      'instructions',
      'toolDeclarations',
    ]);
  });
});
