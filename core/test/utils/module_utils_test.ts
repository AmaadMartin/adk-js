/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createUserContent} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {InputValidationError} from '../../src/errors/input_validation_error.js';
import {resolveFullyQualifiedName} from '../../src/utils/module_utils.js';
import {searchTool} from '../agents/fixtures/config_code_refs.js';
import {
  notAProvider,
  staticProvider,
} from '../tools/fixtures/example_providers.js';

/** Absolute path of the fixture module the resolver loads. */
const FIXTURE_PATH = fileURLToPath(
  new URL('../tools/fixtures/example_providers.ts', import.meta.url),
);

/**
 * Absolute path of a config file sitting next to the fixture. The resolver
 * uses it as a base for a relative specifier and never reads it.
 */
const CONFIG_PATH = fileURLToPath(
  new URL('../tools/fixtures/root_agent.yaml', import.meta.url),
);

describe('resolveFullyQualifiedName', () => {
  it('resolves a named export by identity', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#staticProvider`,
    );

    expect(resolved).toBe(staticProvider);
  });

  it('resolves the default export when the name has no separator', async () => {
    const resolved = await resolveFullyQualifiedName(FIXTURE_PATH);

    expect(resolved).toBe(staticProvider);
  });

  it('resolves the default export when nothing follows the separator', async () => {
    const resolved = await resolveFullyQualifiedName(`${FIXTURE_PATH}#`);

    expect(resolved).toBe(staticProvider);
  });

  it('rebases a relative specifier against the base file', async () => {
    const resolved = await resolveFullyQualifiedName(
      './example_providers.ts#notAProvider',
      CONFIG_PATH,
    );

    expect(resolved).toBe(notAProvider);
  });

  it('ignores the base file for an absolute specifier', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#notAProvider`,
      '/nowhere/root_agent.yaml',
    );

    expect(resolved).toBe(notAProvider);
  });

  it('resolves a bare specifier through normal package resolution', async () => {
    const resolved = await resolveFullyQualifiedName(
      '@google/genai#createUserContent',
    );

    expect(resolved).toBe(createUserContent);
  });

  it('rejects a relative specifier when no base file is given', async () => {
    const resolving = resolveFullyQualifiedName(
      './example_providers.ts#staticProvider',
    );

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      cause: {message: expect.stringContaining('needs the path of the file')},
    });
  });

  it('reports a module that cannot be loaded, keeping the cause', async () => {
    const name = '/no/such/module.ts#provider';
    const resolving = resolveFullyQualifiedName(name);

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      message: `Invalid fully qualified name: ${name}`,
      cause: expect.any(Error),
    });
  });

  it('reports a missing export instead of returning undefined', async () => {
    const name = `${FIXTURE_PATH}#noSuchExport`;
    const resolving = resolveFullyQualifiedName(name);

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      message: `Invalid fully qualified name: ${name}`,
      cause: {
        message: expect.stringContaining('has no export named "noSuchExport"'),
      },
    });
  });

  it('refuses a namespaced Node built-in', async () => {
    const resolving = resolveFullyQualifiedName('node:child_process#execSync');

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      cause: {message: expect.stringContaining('node:child_process')},
    });
  });

  it('refuses a bare Node built-in', async () => {
    const resolving = resolveFullyQualifiedName('fs#readFileSync');

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      cause: {message: expect.stringContaining('"fs"')},
    });
  });
});

describe('resolveFullyQualifiedName, resolving a declarative config reference', () => {
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
