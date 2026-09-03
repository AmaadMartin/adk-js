/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  parseAgentRefConfig,
  parseCodeConfig,
  resolveCodeReference,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {staticProvider} from './fixtures/example_code_refs.js';

/**
 * The messages below are spelled out rather than imported, so that a test
 * fails when a user-visible message changes.
 */
const CODE_CONFIG_SHAPE_MESSAGE =
  'A code reference must be an object with a `name` and no other key.';
const AGENT_REF_SHAPE_MESSAGE =
  'An agent reference must be an object with `code` or `configPath` and no other key.';
const BOTH_SOURCES_MESSAGE =
  'An agent reference sets both `code` and `configPath`; exactly one of `code` and `configPath` must be set.';
const NO_SOURCE_MESSAGE =
  'An agent reference sets neither `code` nor `configPath`; exactly one of `code` and `configPath` must be set.';

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
      CODE_CONFIG_SHAPE_MESSAGE,
    );
    expect(() => parseCodeConfig({name: 'x', args: {}})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a missing name', () => {
    expect(() => parseCodeConfig({})).toThrow(CODE_CONFIG_SHAPE_MESSAGE);
  });

  it('rejects a non-string name', () => {
    expect(() => parseCodeConfig({name: 7})).toThrow(CODE_CONFIG_SHAPE_MESSAGE);
  });

  it('rejects an empty name', () => {
    expect(() => parseCodeConfig({name: ''})).toThrow(
      CODE_CONFIG_SHAPE_MESSAGE,
    );
  });

  it('rejects a value that is not an object', () => {
    for (const raw of ['mod.js#thing', null, [{name: 'x'}]]) {
      expect(() => parseCodeConfig(raw)).toThrow(CODE_CONFIG_SHAPE_MESSAGE);
    }
  });

  it('keeps the validation failure as the cause', () => {
    let caught: unknown;
    try {
      parseCodeConfig({});
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InputValidationError);
    if (!(caught instanceof InputValidationError)) {
      expect.fail('expected an InputValidationError');
    }
    expect(caught.cause).toBeDefined();
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
    ).toThrow(AGENT_REF_SHAPE_MESSAGE);
  });

  it('rejects both code and configPath', () => {
    expect(() =>
      parseAgentRefConfig({code: './agents.js#root', configPath: 'a.yaml'}),
    ).toThrow(BOTH_SOURCES_MESSAGE);
  });

  it('rejects a reference that names neither source', () => {
    expect(() => parseAgentRefConfig({})).toThrow(NO_SOURCE_MESSAGE);
  });

  it('treats an explicit null as not provided', () => {
    expect(parseAgentRefConfig({code: null, configPath: 'a.yaml'})).toEqual({
      configPath: 'a.yaml',
    });
    expect(() => parseAgentRefConfig({code: null})).toThrow(NO_SOURCE_MESSAGE);
  });

  it('rejects an unknown key', () => {
    expect(() =>
      parseAgentRefConfig({code: './agents.js#root', name: 'root'}),
    ).toThrow(AGENT_REF_SHAPE_MESSAGE);
  });

  it('rejects an empty field value', () => {
    expect(() => parseAgentRefConfig({code: ''})).toThrow(
      AGENT_REF_SHAPE_MESSAGE,
    );
  });

  it('rejects a non-string field value', () => {
    expect(() => parseAgentRefConfig({code: 42})).toThrow(
      AGENT_REF_SHAPE_MESSAGE,
    );
  });

  it('rejects a value that is not an object', () => {
    for (const raw of ['./agents.js#root', null, ['./agents.js#root']]) {
      expect(() => parseAgentRefConfig(raw)).toThrow(AGENT_REF_SHAPE_MESSAGE);
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
    expect(error).toHaveProperty('message', CODE_CONFIG_SHAPE_MESSAGE);
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
