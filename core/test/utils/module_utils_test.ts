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
import {namedExport, otherExport} from './fixtures/module_exports.js';

/** Absolute path of the fixture module the resolver loads. */
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/module_exports.ts', import.meta.url),
);

/**
 * Absolute path of a config file sitting next to the fixture. The resolver
 * uses it as a base for a relative specifier and never reads it.
 */
const CONFIG_PATH = fileURLToPath(
  new URL('./fixtures/root_agent.yaml', import.meta.url),
);

describe('resolveFullyQualifiedName', () => {
  it('resolves a named export by identity', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#namedExport`,
    );

    expect(resolved).toBe(namedExport);
  });

  it('resolves the default export when the name has no separator', async () => {
    const resolved = await resolveFullyQualifiedName(FIXTURE_PATH);

    expect(resolved).toBe(namedExport);
  });

  it('resolves the default export when nothing follows the separator', async () => {
    const resolved = await resolveFullyQualifiedName(`${FIXTURE_PATH}#`);

    expect(resolved).toBe(namedExport);
  });

  it('rebases a relative specifier against the base file', async () => {
    const resolved = await resolveFullyQualifiedName(
      './module_exports.ts#otherExport',
      CONFIG_PATH,
    );

    expect(resolved).toBe(otherExport);
  });

  it('ignores the base file for an absolute specifier', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#otherExport`,
      '/nowhere/root_agent.yaml',
    );

    expect(resolved).toBe(otherExport);
  });

  it('resolves a bare specifier through normal package resolution', async () => {
    const resolved = await resolveFullyQualifiedName(
      '@google/genai#createUserContent',
    );

    expect(resolved).toBe(createUserContent);
  });

  it('rejects a relative specifier when no base file is given', async () => {
    const resolving = resolveFullyQualifiedName(
      './module_exports.ts#namedExport',
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
