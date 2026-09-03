/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  parseAgentRefConfig,
  parseCodeConfig,
  resolveAgentReference,
  resolveCodeReference,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {fixtureAgent, staticProvider} from './fixtures/example_code_refs.js';

/** Absolute path of the module the code references below name. */
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/example_code_refs.ts', import.meta.url),
);

/** A config file beside the fixture, standing in for the referring document. */
const FIXTURE_SIBLING_PATH = fileURLToPath(
  new URL('./fixtures/root_agent.yaml', import.meta.url),
);

/** Returns the error a call rejects with, failing the test if it resolves. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => expect.fail('expected the call to reject'),
    (err: unknown) => err,
  );
}

describe('parseCodeConfig', () => {
  it('accepts a name', () => {
    expect(parseCodeConfig({name: `${FIXTURE_PATH}#staticProvider`})).toEqual({
      name: `${FIXTURE_PATH}#staticProvider`,
    });
  });

  it('rejects an unknown key', () => {
    expect(() => parseCodeConfig({name: 'x', args: {}})).toThrow(
      /^Invalid CodeConfig: .*args/,
    );
    expect(() => parseCodeConfig({name: 'x', args: {}})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a missing name', () => {
    expect(() => parseCodeConfig({})).toThrow(/^Invalid CodeConfig: name: /);
  });

  it('rejects a non-string name', () => {
    expect(() => parseCodeConfig({name: 7})).toThrow(
      /^Invalid CodeConfig: name: /,
    );
  });

  it('accepts an empty name, which fails at resolution instead', () => {
    expect(parseCodeConfig({name: ''})).toEqual({name: ''});
  });
});

describe('parseAgentRefConfig', () => {
  it('accepts code alone', () => {
    const parsed = parseAgentRefConfig({code: './agents.js#root'});

    expect(parsed.code).toBe('./agents.js#root');
    expect(parsed.configPath).toBeUndefined();
  });

  it('accepts configPath alone', () => {
    const parsed = parseAgentRefConfig({configPath: 'search_agent.yaml'});

    expect(parsed.configPath).toBe('search_agent.yaml');
    expect(parsed.code).toBeUndefined();
  });

  it('accepts the snake_case alias adk-python writes', () => {
    expect(parseAgentRefConfig({config_path: 'sub.yaml'})).toEqual({
      configPath: 'sub.yaml',
    });
  });

  it('rejects both spellings of the config path at once', () => {
    expect(() =>
      parseAgentRefConfig({config_path: 'a.yaml', configPath: 'b.yaml'}),
    ).toThrow(/^Invalid AgentRefConfig: .*config_path/);
  });

  it('rejects both code and configPath', () => {
    expect(() =>
      parseAgentRefConfig({code: './agents.js#root', configPath: 'a.yaml'}),
    ).toThrow(
      'Invalid AgentRefConfig: Only one of `code` or `configPath` should be provided',
    );
  });

  it('rejects a reference that names neither source', () => {
    expect(() => parseAgentRefConfig({})).toThrow(
      'Invalid AgentRefConfig: Exactly one of `code` or `configPath` must be provided',
    );
  });

  it('treats an explicit null as not provided', () => {
    expect(parseAgentRefConfig({code: null, configPath: 'a.yaml'})).toEqual({
      configPath: 'a.yaml',
    });
    expect(() => parseAgentRefConfig({code: null})).toThrow(
      'Invalid AgentRefConfig: Exactly one of `code` or `configPath` must be provided',
    );
  });

  it('rejects an unknown key', () => {
    expect(() =>
      parseAgentRefConfig({code: './agents.js#root', name: 'root'}),
    ).toThrow(/^Invalid AgentRefConfig: .*name/);
  });

  it('rejects a value that is not an object', () => {
    for (const raw of ['./agents.js#root', null, ['./agents.js#root']]) {
      expect(() => parseAgentRefConfig(raw)).toThrow(
        /^Invalid AgentRefConfig: /,
      );
    }
  });
});

describe('resolveCodeReference', () => {
  it('resolves a named export', async () => {
    await expect(
      resolveCodeReference({name: `${FIXTURE_PATH}#staticProvider`}),
    ).resolves.toBe(staticProvider);
  });

  it('resolves the default export when the name has no separator', async () => {
    await expect(resolveCodeReference({name: FIXTURE_PATH})).resolves.toBe(
      'the default export',
    );
  });

  it('resolves a relative name against the referring file', async () => {
    await expect(
      resolveCodeReference(
        {name: './example_code_refs.ts#staticProvider'},
        FIXTURE_SIBLING_PATH,
      ),
    ).resolves.toBe(staticProvider);
  });

  it('rejects an empty name', async () => {
    const error = await rejectionOf(resolveCodeReference({name: ''}));

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty('message', 'Invalid CodeConfig.');
  });

  it('rejects a Node built-in named with the node: prefix', async () => {
    await expect(
      resolveCodeReference({name: 'node:child_process#exec'}),
    ).rejects.toThrow('Invalid fully qualified name: node:child_process#exec');
  });

  it('rejects a Node built-in named without the prefix', async () => {
    await expect(
      resolveCodeReference({name: 'child_process#exec'}),
    ).rejects.toThrow('Invalid fully qualified name: child_process#exec');
  });

  it('keeps the import failure as the cause of an unknown module', async () => {
    const error = await rejectionOf(
      resolveCodeReference({name: './absent.ts#thing'}, FIXTURE_SIBLING_PATH),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    if (!(error instanceof InputValidationError)) {
      expect.fail('expected an InputValidationError');
    }
    expect(error.message).toBe(
      'Invalid fully qualified name: ./absent.ts#thing',
    );
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('rejects a name whose module has no such export', async () => {
    await expect(
      resolveCodeReference({name: `${FIXTURE_PATH}#absent`}),
    ).rejects.toThrow(`Invalid fully qualified name: ${FIXTURE_PATH}#absent`);
  });
});

describe('resolveAgentReference', () => {
  it('resolves a code reference to the agent it names', async () => {
    await expect(
      resolveAgentReference(
        {code: './example_code_refs.ts#fixtureAgent'},
        FIXTURE_SIBLING_PATH,
      ),
    ).resolves.toBe(fixtureAgent);
  });

  it('rejects a code reference to a value that is not an agent', async () => {
    await expect(
      resolveAgentReference(
        {code: `${FIXTURE_PATH}#staticProvider`},
        FIXTURE_SIBLING_PATH,
      ),
    ).rejects.toThrow(
      `Agent reference \`${FIXTURE_PATH}#staticProvider\` does not resolve to an agent.`,
    );
  });

  it('rejects a config file reference, which adk-js cannot load', async () => {
    const error = await rejectionOf(
      resolveAgentReference({configPath: 'sub.yaml'}, FIXTURE_SIBLING_PATH),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'message',
      'An agent reference by `configPath` is not supported: adk-js has no ' +
        'agent config loader. Name the agent with `code` instead.',
    );
  });

  it('rejects a hand-built reference that names both sources', async () => {
    await expect(
      resolveAgentReference(
        {code: './agents.js#root', configPath: 'a.yaml'},
        FIXTURE_SIBLING_PATH,
      ),
    ).rejects.toThrow('Only one of `code` or `configPath` should be provided');
  });

  it('rejects a hand-built reference that names neither source', async () => {
    await expect(
      resolveAgentReference({}, FIXTURE_SIBLING_PATH),
    ).rejects.toThrow('Exactly one of `code` or `configPath` must be provided');
  });
});
