/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

const {startupLoads} = vi.hoisted(() => ({startupLoads: [] as string[]}));

vi.mock('../../src/utils/envs.js', () => ({
  loadDotenvForAgent: (agentPath: string) => {
    startupLoads.push(agentPath);
  },
}));

describe('CLI startup .env loading', () => {
  it('loads the working directory .env through loadDotenvForAgent', async () => {
    await import('../../src/cli/cli.js');

    // Reading the file here, rather than with dotenv.config(), is what keeps
    // its keys overridable by an agent's own .env.
    expect(startupLoads).toEqual([process.cwd()]);
  });
});
