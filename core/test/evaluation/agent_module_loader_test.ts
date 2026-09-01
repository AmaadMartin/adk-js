/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {dirname, join, relative as relativeFromCwd, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {getAgentForEval} from '../../src/evaluation/agent_module_loader.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return join(FIXTURES, `${name}.ts`);
}

describe('getAgentForEval', () => {
  it('resolves the rootAgent export and reports no app', async () => {
    const {agent, app} = await getAgentForEval(fixture('root_agent_module'));

    expect(agent.name).toBe('dice_agent');
    expect(app).toBeUndefined();
  });

  it('resolves the App and the agent it wraps', async () => {
    const {agent, app} = await getAgentForEval(fixture('app_module'));

    expect(agent.name).toBe('dice_agent');
    expect(app?.name).toBe('dice_app');
  });

  it('resolves a rootApp export', async () => {
    const {agent, app} = await getAgentForEval(fixture('root_app_module'));

    expect(agent.name).toBe('dice_agent');
    expect(app?.name).toBe('dice_app');
  });

  it('ignores an app export that is not an App', async () => {
    const {agent, app} = await getAgentForEval(
      fixture('plain_app_export_module'),
    );

    expect(agent.name).toBe('dice_agent');
    expect(app).toBeUndefined();
  });

  it('surfaces the App even when a sub-agent is selected', async () => {
    const {agent, app} = await getAgentForEval(
      fixture('app_module'),
      'roll_agent',
    );

    expect(agent.name).toBe('roll_agent');
    expect(app?.name).toBe('dice_app');
  });

  it('selects a sub-agent of a bare root agent', async () => {
    const {agent} = await getAgentForEval(
      fixture('root_agent_module'),
      'roll_agent',
    );

    expect(agent.name).toBe('roll_agent');
  });

  it('awaits a getAgentAsync factory that returns a tuple', async () => {
    const {agent} = await getAgentForEval(fixture('agent_factory_module'));

    expect(agent.name).toBe('factory_agent');
  });

  it('awaits a getAgentAsync factory that returns the agent itself', async () => {
    const {agent} = await getAgentForEval(fixture('bare_factory_module'));

    expect(agent.name).toBe('bare_factory_agent');
  });

  it.each([
    ['no agent export at all', 'no_agent_module'],
    ['a factory that produces no agent', 'empty_factory_module'],
  ])('rejects a module with %s', async (_name, moduleName) => {
    await expect(getAgentForEval(fixture(moduleName))).rejects.toThrowError(
      InputValidationError,
    );
  });

  it('rejects a sub-agent name that is not in the tree', async () => {
    await expect(
      getAgentForEval(fixture('root_agent_module'), 'missing_agent'),
    ).rejects.toThrowError("Sub-Agent 'missing_agent' not found.");
  });

  it('refuses a Node built-in as an agent module', async () => {
    await expect(getAgentForEval('node:child_process')).rejects.toThrowError(
      'Module node:child_process is a Node built-in, not an agent module.',
    );
  });

  it('refuses a Node built-in named without the prefix', async () => {
    await expect(getAgentForEval('fs')).rejects.toThrowError(
      'Module fs is a Node built-in, not an agent module.',
    );
  });

  it('loads a module named by a package specifier', async () => {
    await expect(getAgentForEval('@google/adk')).rejects.toThrowError(
      'Module @google/adk does not export a `rootAgent` or a ' +
        '`getAgentAsync`.',
    );
  });

  it('loads a module named by a relative path', async () => {
    const relative = `.${sep}${relativeFromCwd(
      process.cwd(),
      fixture('root_agent_module'),
    )}`;

    const {agent} = await getAgentForEval(relative);

    expect(agent.name).toBe('dice_agent');
  });
});
