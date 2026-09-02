/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {inferAgentOrigin, LlmAgent, stampAgentOrigin} from '@google/adk';
import {describe, expect, it} from 'vitest';

function agent(name: string): LlmAgent {
  return new LlmAgent({name, model: 'gemini-2.0-flash'});
}

describe('agent origin', () => {
  it('reads back the origin a loader stamped', () => {
    const root = agent('root');

    stampAgentOrigin(root, {appName: 'billing', path: '/apps/billing'});

    expect(inferAgentOrigin(root)).toEqual({
      appName: 'billing',
      path: '/apps/billing',
    });
  });

  it('reports an empty origin for an agent no loader stamped', () => {
    expect(inferAgentOrigin(agent('root'))).toEqual({});
  });

  it('keeps each agent to its own origin', () => {
    const first = agent('first');
    const second = agent('second');

    stampAgentOrigin(first, {appName: 'billing'});

    expect(inferAgentOrigin(second)).toEqual({});
  });

  it('replaces an origin when a loader stamps the agent again', () => {
    const root = agent('root');

    stampAgentOrigin(root, {appName: 'old', path: '/apps/old'});
    stampAgentOrigin(root, {appName: 'new', path: '/apps/new'});

    expect(inferAgentOrigin(root)).toEqual({
      appName: 'new',
      path: '/apps/new',
    });
  });
});
