/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentDetailsSchema,
  AppDetailsSchema,
  getDeveloperInstructions,
  getToolsByAgentName,
} from '@google/adk';
import {FunctionDeclaration, Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('evaluation/app_details', () => {
  describe('AgentDetailsSchema', () => {
    it('applies defaults for instructions and toolDeclarations', () => {
      const agent = AgentDetailsSchema.parse({name: 'agent1'});
      expect(agent.instructions).toBe('');
      expect(agent.toolDeclarations).toEqual([]);
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        AgentDetailsSchema.safeParse({name: 'agent1', extra: 1}).success,
      ).toBe(false);
    });
  });

  describe('AppDetailsSchema', () => {
    it('defaults agentDetails to an empty record', () => {
      const app = AppDetailsSchema.parse({});
      expect(app.agentDetails).toEqual({});
    });
  });

  describe('getDeveloperInstructions', () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: {name: 'agent1', instructions: 'instruction for agent1'},
        agent2: {name: 'agent2', instructions: 'instruction for agent2'},
      },
    });

    it('returns instructions for an existing agent', () => {
      expect(getDeveloperInstructions(appDetails, 'agent1')).toBe(
        'instruction for agent1',
      );
    });

    it('throws for a non-existing agent', () => {
      expect(() => getDeveloperInstructions(appDetails, 'agent3')).toThrow(
        '`agent3` not found in the agentic system.',
      );
    });
  });

  describe('getToolsByAgentName', () => {
    it('maps each agent name to its tool declarations', () => {
      const tool1: Tool = {
        functionDeclarations: [{name: 'tool1_func'} as FunctionDeclaration],
      };
      const appDetails = AppDetailsSchema.parse({
        agentDetails: {
          agent1: {name: 'agent1', toolDeclarations: [tool1]},
          agent2: {name: 'agent2', toolDeclarations: []},
        },
      });

      expect(getToolsByAgentName(appDetails)).toEqual({
        agent1: [tool1],
        agent2: [],
      });
    });
  });
});
