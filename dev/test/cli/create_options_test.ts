/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {
  AGENT_TYPE_OPTION,
  AgentType,
  toAgentType,
} from '../../src/cli/create_options.js';
import {applyExitOverride, runExpectingError} from './command_utils.js';

vi.mock('../../src/cli/cli_create', () => ({
  createAgent: vi.fn(),
}));

describe('toAgentType', () => {
  it('keeps CONFIG', () => {
    expect(toAgentType('CONFIG')).toBe(AgentType.CONFIG);
  });

  it('keeps CODE', () => {
    expect(toAgentType('CODE')).toBe(AgentType.CODE);
  });

  it('defaults to CODE when the flag is absent', () => {
    expect(toAgentType(undefined)).toBe(AgentType.CODE);
  });

  it('defaults to CODE for a spelling the option parser never emits', () => {
    expect(toAgentType('config')).toBe(AgentType.CODE);
  });
});

describe('AGENT_TYPE_OPTION', () => {
  it('defaults to CODE and offers both types', () => {
    expect(AGENT_TYPE_OPTION.defaultValue).toBe(AgentType.CODE);
    expect(AGENT_TYPE_OPTION.argChoices).toEqual([
      AgentType.CODE,
      AgentType.CONFIG,
    ]);
  });
});

describe('adk create --type', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = applyExitOverride(createProgram());
  });

  it('accepts a lower-case --type and normalizes it', async () => {
    await program.parseAsync(['create', 'my-agent', '--type', 'config'], {
      from: 'user',
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({agentType: AgentType.CONFIG}),
    );
  });

  it('creates a code agent when --type is absent', async () => {
    await program.parseAsync(['create', 'my-agent'], {from: 'user'});

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({agentType: AgentType.CODE}),
    );
  });

  it('refuses an unknown --type, and never creates an agent', async () => {
    const error = await runExpectingError(program, [
      'create',
      'my-agent',
      '--type',
      'yaml',
    ]);

    expect(error?.code).toBe('commander.invalidArgument');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('lists --type in the create help', () => {
    const create = program.commands.find(
      (command) => command.name() === 'create',
    );
    expect(create).toBeDefined();
    expect(create?.helpInformation()).toContain('--type <string>');
  });
});
