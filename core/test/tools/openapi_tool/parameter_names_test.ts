/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  defaultParameterName,
  deriveParameterName,
  renamePythonKeywords,
} from '../../../src/tools/openapi_tool/openapi_spec_parser/parameter_names.js';

describe('parameter_names', () => {
  describe('renamePythonKeywords', () => {
    it('should prefix a reserved word', () => {
      expect(renamePythonKeywords('if')).toBe('param_if');
      expect(renamePythonKeywords('lambda')).toBe('param_lambda');
    });

    it('should match a reserved word case-sensitively', () => {
      expect(renamePythonKeywords('True')).toBe('param_True');
      expect(renamePythonKeywords('true')).toBe('true');
    });

    it('should leave a soft keyword alone', () => {
      expect(renamePythonKeywords('match')).toBe('match');
    });

    it('should leave an ordinary name alone', () => {
      expect(renamePythonKeywords('user')).toBe('user');
    });

    it('should honour a custom prefix', () => {
      expect(renamePythonKeywords('class', 'arg_')).toBe('arg_class');
    });
  });

  describe('defaultParameterName', () => {
    it('should name each parameter location', () => {
      expect(defaultParameterName('body')).toBe('body');
      expect(defaultParameterName('query')).toBe('query_param');
      expect(defaultParameterName('path')).toBe('path_param');
      expect(defaultParameterName('header')).toBe('header_param');
      expect(defaultParameterName('cookie')).toBe('cookie_param');
    });

    it('should fall back to value for an unnamed location', () => {
      expect(defaultParameterName('')).toBe('value');
      expect(defaultParameterName('formData')).toBe('value');
    });

    it('should not read a name off the object prototype', () => {
      expect(defaultParameterName('constructor')).toBe('value');
    });
  });

  describe('deriveParameterName', () => {
    it('should convert the original name to snake_case', () => {
      expect(deriveParameterName('X-Trace-Id', 'header', false)).toBe(
        'x_trace_id',
      );
    });

    it('should keep the original name when asked to preserve it', () => {
      expect(deriveParameterName('spaceName', 'body', true)).toBe('spaceName');
    });

    it('should prefix a reserved word it preserves', () => {
      expect(deriveParameterName('class', 'query', true)).toBe('param_class');
    });

    it('should prefix a reserved word it infers', () => {
      expect(deriveParameterName('lambda', 'query', false)).toBe(
        'param_lambda',
      );
    });

    it('should fall back to the location when the name yields nothing', () => {
      expect(deriveParameterName('', 'body', false)).toBe('body');
      expect(deriveParameterName('---', 'query', false)).toBe('query_param');
    });

    it('should fall back to the location when preserving an empty name', () => {
      expect(deriveParameterName('', 'path', true)).toBe('path_param');
    });
  });
});
