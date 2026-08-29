/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {
  DEFAULT_OUTPUT_PATH,
  convertGoogleApi,
} from '../../src/cli/cli_googleapi_to_openapi.js';

const {converterMock, convertMock, saveMock} = vi.hoisted(() => ({
  converterMock: vi.fn(),
  convertMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    GoogleApiToOpenApiConverter: converterMock,
  };
});

vi.mock('../../src/version', () => ({version: '1.0.0-test'}));

describe('convertGoogleApi', () => {
  /** The order in which the converter methods ran. */
  let calls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    convertMock.mockImplementation(async () => {
      calls.push('convert');
    });
    saveMock.mockImplementation(async () => {
      calls.push('save');
    });
    converterMock.mockImplementation(() => ({
      convert: convertMock,
      saveOpenApiSpec: saveMock,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts before it saves', async () => {
    await convertGoogleApi({
      apiName: 'calendar',
      apiVersion: 'v3',
      output: 'out.json',
    });

    expect(converterMock).toHaveBeenCalledWith('calendar', 'v3');
    expect(saveMock).toHaveBeenCalledWith('out.json');
    expect(calls).toEqual(['convert', 'save']);
  });

  it('does not write a file when the conversion fails', async () => {
    convertMock.mockRejectedValue(new Error('HTTP 404'));

    await expect(
      convertGoogleApi({
        apiName: 'calendar',
        apiVersion: 'v3',
        output: 'out.json',
      }),
    ).rejects.toThrow('HTTP 404');
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('the googleapi_to_openapi command', () => {
  let program: ReturnType<typeof createProgram>;
  let exitMock: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    convertMock.mockResolvedValue(undefined);
    saveMock.mockResolvedValue(undefined);
    converterMock.mockImplementation(() => ({
      convert: convertMock,
      saveOpenApiSpec: saveMock,
    }));
    exitMock = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as () => never);
    program = createProgram();
    program.exitOverride();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const parse = async (args: string[]) => {
    await program.parseAsync(args, {from: 'user'});
  };

  it('defaults the output path', async () => {
    await parse(['googleapi_to_openapi', 'calendar', 'v3']);

    expect(converterMock).toHaveBeenCalledWith('calendar', 'v3');
    expect(saveMock).toHaveBeenCalledWith(DEFAULT_OUTPUT_PATH);
    expect(DEFAULT_OUTPUT_PATH).toBe('openapi_spec.json');
  });

  it.each(['-o', '--output'])(
    'overrides the output path with %s',
    async (flag) => {
      await parse([
        'googleapi_to_openapi',
        'docs',
        'v1',
        flag,
        'docs_api.json',
      ]);

      expect(converterMock).toHaveBeenCalledWith('docs', 'v1');
      expect(saveMock).toHaveBeenCalledWith('docs_api.json');
    },
  );

  it('exits with status 1 when the conversion fails', async () => {
    convertMock.mockRejectedValue(new Error('HTTP 404'));

    await parse(['googleapi_to_openapi', 'calendar', 'v3']);

    expect(saveMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
