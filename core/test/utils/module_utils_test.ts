/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {resolveFullyQualifiedName} from '../../src/utils/module_utils.js';
import {searchTool} from '../agents/fixtures/config_code_refs.js';

/** Absolute path of the module the qualified names below name. */
const FIXTURE_PATH = fileURLToPath(
  new URL('../agents/fixtures/config_code_refs.ts', import.meta.url),
);

/** A file beside the fixture, standing in for a config file that names it. */
const SIBLING_PATH = fileURLToPath(
  new URL('../agents/fixtures/root_agent.yaml', import.meta.url),
);

/** A file one directory below the fixture, for a `../` specifier. */
const NESTED_PATH = fileURLToPath(
  new URL('../agents/fixtures/nested/root_agent.yaml', import.meta.url),
);

/** Returns the error a call rejects with, failing the test if it resolves. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => expect.fail('expected the call to reject'),
    (err: unknown) => err,
  );
}

describe('resolveFullyQualifiedName', () => {
  it('reads the named export of an absolute specifier', async () => {
    await expect(
      resolveFullyQualifiedName(`${FIXTURE_PATH}#searchTool`),
    ).resolves.toBe(searchTool);
  });

  it('reads the named export of a relative specifier', async () => {
    await expect(
      resolveFullyQualifiedName(
        './config_code_refs.ts#searchTool',
        SIBLING_PATH,
      ),
    ).resolves.toBe(searchTool);
  });

  it('reads the named export of a parent-relative specifier', async () => {
    await expect(
      resolveFullyQualifiedName(
        '../config_code_refs.ts#searchTool',
        NESTED_PATH,
      ),
    ).resolves.toBe(searchTool);
  });

  it('reads the default export when the name carries no separator', async () => {
    await expect(resolveFullyQualifiedName(FIXTURE_PATH)).resolves.toBe(
      'the default export',
    );
  });

  it('reads the default export when the separator ends the name', async () => {
    await expect(resolveFullyQualifiedName(`${FIXTURE_PATH}#`)).resolves.toBe(
      'the default export',
    );
  });

  it('reads a bare specifier through normal package resolution', async () => {
    await expect(resolveFullyQualifiedName('zod#z')).resolves.toBeDefined();
  });

  it('refuses a relative specifier with no base file path', async () => {
    const error = await rejectionOf(
      resolveFullyQualifiedName('./config_code_refs.ts#searchTool'),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'message',
      'Invalid fully qualified name: ./config_code_refs.ts#searchTool',
    );
    expect(error).toHaveProperty(
      'cause.message',
      'Relative specifier "./config_code_refs.ts" needs the path of the ' +
        'file it came from.',
    );
  });

  it('refuses a Node built-in named with the node: prefix', async () => {
    const error = await rejectionOf(
      resolveFullyQualifiedName('node:child_process#exec'),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'cause.message',
      'Node built-in module "node:child_process" cannot be named in a ' +
        'configuration file.',
    );
  });

  it('refuses a Node built-in named without the prefix', async () => {
    const error = await rejectionOf(
      resolveFullyQualifiedName('child_process#exec'),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'cause.message',
      'Node built-in module "child_process" cannot be named in a ' +
        'configuration file.',
    );
  });

  it('refuses a data: URL, which carries its own module body', async () => {
    const dataUrl = 'data:text/javascript,export const run = () => 1';
    const error = await rejectionOf(
      resolveFullyQualifiedName(`${dataUrl}#run`),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'cause.message',
      `Module specifier "${dataUrl}" uses the "data:" URL scheme. A ` +
        'configuration file can name a file path or a package, nothing else.',
    );
  });

  it('refuses an https: URL before it is fetched', async () => {
    const error = await rejectionOf(
      resolveFullyQualifiedName('https://example.test/evil.js#run'),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'cause.message',
      'Module specifier "https://example.test/evil.js" uses the "https:" ' +
        'URL scheme. A configuration file can name a file path or a ' +
        'package, nothing else.',
    );
  });

  it('refuses a name whose module does not exist', async () => {
    const error = await rejectionOf(
      resolveFullyQualifiedName('./no_such_module.ts#thing', SIBLING_PATH),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'message',
      'Invalid fully qualified name: ./no_such_module.ts#thing',
    );
    expect(error).toHaveProperty('cause');
  });

  it('refuses a name whose export does not exist', async () => {
    const error = await rejectionOf(
      resolveFullyQualifiedName(`${FIXTURE_PATH}#noSuchExport`),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'cause.message',
      `Module "${FIXTURE_PATH}" has no export named "noSuchExport".`,
    );
  });
});
