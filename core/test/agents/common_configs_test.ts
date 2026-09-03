/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  parseAgentRefConfig,
  parseCodeConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('parseCodeConfig', () => {
  it('keeps the name of a valid reference', () => {
    expect(parseCodeConfig({name: './my_tools.js#searchTool'})).toEqual({
      name: './my_tools.js#searchTool',
    });
  });

  it('rejects an unknown key', () => {
    expect(() =>
      parseCodeConfig({name: './my_tools.js#searchTool', args: {a: 1}}),
    ).toThrow(InputValidationError);
  });

  it('rejects an empty name', () => {
    expect(() => parseCodeConfig({name: ''})).toThrow(
      'A code reference must be an object with a `name` and no other key.',
    );
  });

  it('rejects a missing name', () => {
    expect(() => parseCodeConfig({})).toThrow(InputValidationError);
  });

  it('keeps the schema failure as the error cause', () => {
    try {
      parseCodeConfig({name: 42});
      expect.fail('expected the call to throw');
    } catch (error: unknown) {
      expect(error).toHaveProperty('cause.issues');
    }
  });
});

describe('parseAgentRefConfig', () => {
  it('accepts a code reference', () => {
    expect(parseAgentRefConfig({code: './agents.js#helper'})).toEqual({
      code: './agents.js#helper',
      configPath: undefined,
    });
  });

  it('accepts a config path', () => {
    expect(parseAgentRefConfig({configPath: './helper.yaml'})).toEqual({
      code: undefined,
      configPath: './helper.yaml',
    });
  });

  it('accepts the config_path spelling adk-python writes', () => {
    expect(parseAgentRefConfig({'config_path': './helper.yaml'})).toEqual({
      code: undefined,
      configPath: './helper.yaml',
    });
  });

  it('treats an explicit null as absent', () => {
    expect(
      parseAgentRefConfig({code: './agents.js#helper', configPath: null}),
    ).toEqual({code: './agents.js#helper', configPath: undefined});
  });

  it('rejects a reference that sets both sources', () => {
    expect(() =>
      parseAgentRefConfig({code: './agents.js#helper', configPath: './h.yaml'}),
    ).toThrow(
      'An agent reference sets both `code` and `configPath`; exactly one of ' +
        '`code` and `configPath` must be set.',
    );
  });

  it('rejects a reference that sets neither source', () => {
    expect(() => parseAgentRefConfig({})).toThrow(
      'An agent reference sets neither `code` nor `configPath`; exactly one ' +
        'of `code` and `configPath` must be set.',
    );
  });

  it('rejects an unknown key', () => {
    expect(() =>
      parseAgentRefConfig({code: './agents.js#helper', name: 'helper'}),
    ).toThrow(InputValidationError);
  });

  it('rejects a reference that is not an object', () => {
    expect(() => parseAgentRefConfig('./helper.yaml')).toThrow(
      InputValidationError,
    );
    expect(() => parseAgentRefConfig([{code: './agents.js#helper'}])).toThrow(
      InputValidationError,
    );
    expect(() => parseAgentRefConfig(null)).toThrow(InputValidationError);
  });

  it('keeps both spellings when a document writes both, and rejects it', () => {
    expect(() =>
      parseAgentRefConfig({
        'configPath': './a.yaml',
        'config_path': './b.yaml',
      }),
    ).toThrow(InputValidationError);
  });
});
