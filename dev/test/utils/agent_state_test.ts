/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, SequentialAgent, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {createEmptyState} from '../../src/utils/agent_state.js';

describe('createEmptyState', () => {
  it('collects the placeholders an instruction reads', () => {
    const agent = new LlmAgent({
      name: 'greeter',
      instruction: 'Greet {user_name} on behalf of {company}.',
    });

    expect(createEmptyState(agent)).toEqual({user_name: '', company: ''});
  });

  it('collects the placeholders of every agent in the tree', () => {
    const agent = new SequentialAgent({
      name: 'root',
      subAgents: [
        new LlmAgent({name: 'first', instruction: 'Use {alpha}.'}),
        new LlmAgent({name: 'second', instruction: 'Use {beta}.'}),
      ],
    });

    expect(createEmptyState(agent)).toEqual({alpha: '', beta: ''});
  });

  it('ignores an instruction supplied by a function', () => {
    const agent = new LlmAgent({
      name: 'greeter',
      instruction: () => 'Greet {user_name}.',
    });

    expect(createEmptyState(agent)).toEqual({});
  });

  it('yields nothing for an agent with no instruction', () => {
    expect(createEmptyState(new LlmAgent({name: 'bare'}))).toEqual({});
  });

  it('yields nothing for a workflow root, which has no instruction', () => {
    const step = new LlmAgent({name: 'step', instruction: 'Use {gamma}.'});
    const workflow = new Workflow({name: 'flow', edges: [['START', step]]});

    expect(createEmptyState(workflow)).toEqual({});
  });
});
