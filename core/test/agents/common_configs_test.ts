/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  agentRefConfigSchema,
  codeConfigSchema,
  InputValidationError,
  parseAgentRefConfig,
  parseCodeConfig,
  resolveCodeReference,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {requireExactlyOneSource} from '../../src/agents/common_configs.js';
import {staticProvider} from './fixtures/example_code_refs.js';

function firstIssueMessage(result: {
  success: boolean;
  error?: {issues: Array<{message: string}>};
}): string {
  if (result.success || result.error === undefined) {
    expect.fail('expected the document to be rejected');
  }
  return result.error.issues[0].message;
}

function messageOf(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? '' : z.prettifyError(result.error);
}

/** Validates an agent reference the way the agent config schema does. */
function parseRef(raw: unknown) {
  return requireExactlyOneSource(agentRefConfigSchema.parse(raw));
}

describe('codeConfigSchema', () => {
  it('accepts a name', () => {
    expect(
      codeConfigSchema.parse({name: 'my_library.my_tools.my_tool'}),
    ).toEqual({name: 'my_library.my_tools.my_tool'});
  });

  it('requires a name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    const result = codeConfigSchema.safeParse({name: 'my_tool', args: {a: 1}});

    expect(firstIssueMessage(result)).toContain('args');
  });
});

describe('codeConfigSchema, as a declarative code reference', () => {
  it('keeps the name of a valid reference', () => {
    expect(codeConfigSchema.parse({name: './my_tools.js#searchTool'})).toEqual({
      name: './my_tools.js#searchTool',
    });
  });

  it('rejects an unknown key', () => {
    expect(
      codeConfigSchema.safeParse({name: './my_tools.js#t', args: {a: 1}})
        .success,
    ).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(codeConfigSchema.safeParse({name: ''}).success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a name that is not a string', () => {
    expect(codeConfigSchema.safeParse({name: 42}).success).toBe(false);
  });
});

describe('agentRefConfigSchema', () => {
  it.each([
    ['code', {code: 'my_library.agents.my_agent'}],
    ['config_path', {config_path: 'sub.yaml'}],
    ['configPath', {configPath: 'sub.yaml'}],
  ])('accepts %s on its own', (_name, document) => {
    expect(agentRefConfigSchema.safeParse(document).success).toBe(true);
  });

  it('leaves the source that was not given undefined', () => {
    expect(agentRefConfigSchema.parse({config_path: 'sub.yaml'})).toEqual({
      configPath: 'sub.yaml',
    });
  });

  it('rejects a reference that names both sources', () => {
    const result = agentRefConfigSchema.safeParse({
      code: 'my_library.agents.my_agent',
      config_path: 'sub.yaml',
    });

    expect(firstIssueMessage(result)).toBe(
      'Only one of `code` or `configPath` should be provided',
    );
  });

  it('rejects a reference that names no source', () => {
    const result = agentRefConfigSchema.safeParse({});

    expect(firstIssueMessage(result)).toBe(
      'Exactly one of `code` or `configPath` must be provided',
    );
  });

  it('rejects an unknown key', () => {
    const result = agentRefConfigSchema.safeParse({
      code: 'my_library.agents.my_agent',
      name: 'my_agent',
    });

    expect(firstIssueMessage(result)).toContain('name');
  });
});

describe('agentRefConfigSchema, as a sub-agent reference', () => {
  it('rejects a reference that sets both code and configPath', () => {
    const result = agentRefConfigSchema.safeParse({
      code: 'my_library.custom_agents.my_agent',
      configPath: 'search_agent.yaml',
    });

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain(
      'Only one of `code` or `configPath` should be provided',
    );
  });

  it('rejects a reference that sets neither code nor configPath', () => {
    const result = agentRefConfigSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain(
      'Exactly one of `code` or `configPath` must be provided',
    );
  });

  it('accepts a code reference and leaves configPath unset', () => {
    const ref = agentRefConfigSchema.parse({
      code: 'my_library.custom_agents.my_agent',
    });

    expect(ref).toEqual({code: 'my_library.custom_agents.my_agent'});
    expect(ref.configPath).toBeUndefined();
  });

  it('accepts a config path reference and leaves code unset', () => {
    const ref = agentRefConfigSchema.parse({configPath: 'search_agent.yaml'});

    expect(ref).toEqual({configPath: 'search_agent.yaml'});
    expect(ref.code).toBeUndefined();
  });

  it('accepts the config_path spelling and yields configPath', () => {
    const ref = agentRefConfigSchema.parse({config_path: 'search_agent.yaml'});

    expect(ref.configPath).toBe('search_agent.yaml');
  });

  it('treats a null source as not provided', () => {
    const ref = agentRefConfigSchema.parse({
      config_path: 'search_agent.yaml',
      code: null,
    });

    expect(ref.configPath).toBe('search_agent.yaml');
    expect(ref.code).toBeUndefined();
  });

  it('rejects an unknown key', () => {
    const result = agentRefConfigSchema.safeParse({
      configPath: 'search_agent.yaml',
      agent_name: 'search_agent',
    });

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain('agentName');
  });

  it('rejects an empty code and an empty configPath', () => {
    expect(agentRefConfigSchema.safeParse({code: ''}).success).toBe(false);
    expect(agentRefConfigSchema.safeParse({configPath: ''}).success).toBe(
      false,
    );
  });
});

describe('codeConfigSchema, as a callback reference', () => {
  it('accepts a name', () => {
    expect(
      codeConfigSchema.parse({
        name: 'my_library.my_callbacks.my_callback',
      }),
    ).toEqual({name: 'my_library.my_callbacks.my_callback'});
  });

  it('rejects an unknown key', () => {
    const result = codeConfigSchema.safeParse({
      name: 'my_library.my_tools.my_tool',
      args: {limit: 3},
    });

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain('args');
  });

  it('rejects a missing name and an empty name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
    expect(codeConfigSchema.safeParse({name: ''}).success).toBe(false);
  });
});

describe('agentRefConfigSchema, as a declarative agent reference', () => {
  it('accepts a code reference', () => {
    expect(parseRef({code: './agents.js#helper'})).toEqual({
      code: './agents.js#helper',
      configPath: undefined,
    });
  });

  it('accepts a config path', () => {
    expect(parseRef({configPath: './helper.yaml'})).toEqual({
      code: undefined,
      configPath: './helper.yaml',
    });
  });

  it('accepts the config_path spelling adk-python writes', () => {
    expect(parseRef({'config_path': './helper.yaml'})).toEqual({
      code: undefined,
      configPath: './helper.yaml',
    });
  });

  it('treats an explicit null as absent', () => {
    expect(parseRef({code: './agents.js#helper', configPath: null})).toEqual({
      code: './agents.js#helper',
      configPath: undefined,
    });
  });

  it('rejects an unknown key', () => {
    expect(
      agentRefConfigSchema.safeParse({
        code: './agents.js#helper',
        name: 'helper',
      }).success,
    ).toBe(false);
  });

  it('keeps both spellings when a document writes both, and rejects it', () => {
    expect(
      agentRefConfigSchema.safeParse({
        'configPath': './a.yaml',
        'config_path': './b.yaml',
      }).success,
    ).toBe(false);
  });

  it('rejects a reference that is not an object', () => {
    expect(agentRefConfigSchema.safeParse('./helper.yaml').success).toBe(false);
    expect(
      agentRefConfigSchema.safeParse([{code: './agents.js#helper'}]).success,
    ).toBe(false);
    expect(agentRefConfigSchema.safeParse(null).success).toBe(false);
  });
});

describe('requireExactlyOneSource', () => {
  it('rejects a reference that sets both sources', () => {
    expect(() =>
      requireExactlyOneSource({
        code: './agents.js#helper',
        configPath: './h.yaml',
      }),
    ).toThrow(
      'An agent reference sets both `code` and `configPath`; exactly one of ' +
        '`code` and `configPath` must be set.',
    );
  });

  it('rejects a reference that sets neither source', () => {
    expect(() => requireExactlyOneSource({})).toThrow(
      'An agent reference sets neither `code` nor `configPath`; exactly one ' +
        'of `code` and `configPath` must be set.',
    );
  });
});

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
