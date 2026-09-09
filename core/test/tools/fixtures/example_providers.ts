/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture module that `resolveFullyQualifiedName` imports by path, standing in
 * for the user code an agent config file names.
 */

import {BaseExampleProvider, Example} from '@google/adk';

/** The single example {@link staticProvider} returns. */
export const FIXTURE_EXAMPLE: Example = {
  input: {parts: [{text: 'How do I reset my password?'}]},
  output: [{role: 'model', parts: [{text: 'Open Settings, then Security.'}]}],
};

class StaticExampleProvider extends BaseExampleProvider {
  override getExamples(_query: string): Example[] {
    return [FIXTURE_EXAMPLE];
  }
}

/** A real provider, resolved by name in the tests. */
export const staticProvider = new StaticExampleProvider();

/**
 * A plain object with the provider's method but without its identity symbol.
 * It proves the check is a type guard rather than a shape check.
 */
export const notAProvider = {getExamples: (): Example[] => []};

export default staticProvider;
