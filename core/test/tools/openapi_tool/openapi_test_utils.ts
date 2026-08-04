/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {expect} from 'vitest';

/**
 * Narrows an OpenAPI union to its inlined member, failing the test if the spec
 * carried a `$ref` instead. Most OpenAPI containers are typed
 * `T | ReferenceObject`, and discriminating on `$ref` is what those unions are
 * for.
 */
export function inlined<T extends object>(
  value: T | OpenAPIV3.ReferenceObject | undefined,
): T {
  if (!value) {
    expect.fail('expected an inlined OpenAPI object, found nothing');
  }
  if ('$ref' in value) {
    expect.fail(`expected an inlined OpenAPI object, found $ref ${value.$ref}`);
  }
  return value;
}
