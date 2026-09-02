/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toSnakeCaseName} from '../../../utils/case_utils.js';

/**
 * The reserved words of Python 3, as `keyword.iskeyword` reports them. The
 * soft keywords (`match`, `case`, `type`, `_`) are absent because
 * `keyword.iskeyword` rejects them too.
 */
const PYTHON_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/** The argument name each parameter location falls back to. */
const LOCATION_DEFAULT_NAMES = new Map([
  ['body', 'body'],
  ['query', 'query_param'],
  ['path', 'path_param'],
  ['header', 'header_param'],
  ['cookie', 'cookie_param'],
]);

/** The argument name used for a location the spec does not name. */
const FALLBACK_PARAMETER_NAME = 'value';

/**
 * Prefixes a Python reserved word so it can serve as an argument name.
 *
 * These names travel on the wire as tool argument names, not as TypeScript
 * identifiers. adk-python applies the same list, so keeping it identical is
 * what makes one OpenAPI document produce one tool signature in both SDKs.
 *
 * @param name The candidate argument name.
 * @param prefix The prefix to add to a reserved word.
 * @returns The prefixed name for a reserved word, otherwise `name` unchanged.
 */
export function renamePythonKeywords(name: string, prefix = 'param_'): string {
  return PYTHON_KEYWORDS.has(name) ? prefix + name : name;
}

/**
 * Returns the argument name for a parameter whose own name yields nothing.
 *
 * @param paramLocation The OpenAPI parameter location, such as `query`.
 * @returns The default argument name for that location.
 */
export function defaultParameterName(paramLocation: string): string {
  return LOCATION_DEFAULT_NAMES.get(paramLocation) ?? FALLBACK_PARAMETER_NAME;
}

/**
 * Derives the argument name a tool exposes for an OpenAPI parameter.
 *
 * @param originalName The name the OpenAPI document gives the parameter.
 * @param paramLocation The OpenAPI parameter location, such as `query`.
 * @param preservePropertyNames Whether to keep the original name instead of
 *   converting it to snake_case.
 * @returns The argument name.
 */
export function deriveParameterName(
  originalName: string,
  paramLocation: string,
  preservePropertyNames: boolean,
): string {
  const preserved = preservePropertyNames
    ? renamePythonKeywords(originalName)
    : '';
  if (preserved) {
    return preserved;
  }
  const inferred = renamePythonKeywords(toSnakeCaseName(originalName));
  return inferred || defaultParameterName(paramLocation);
}
