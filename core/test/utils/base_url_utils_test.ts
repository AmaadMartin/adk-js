/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
// `normalizeBaseUrlAndApiVersion` is internal and deliberately not exported
// from the package barrel.
import {normalizeBaseUrlAndApiVersion} from '../../src/utils/base_url_utils.js';

interface TestCase {
  input: string | undefined;
  baseUrl: string | undefined;
  apiVersion: string | undefined;
  why: string;
}

const CASES: TestCase[] = [
  {
    input: undefined,
    baseUrl: undefined,
    apiVersion: undefined,
    why: 'nothing configured',
  },
  {
    input: '',
    baseUrl: undefined,
    apiVersion: undefined,
    why: 'an empty base URL counts as unset',
  },
  {
    input: 'https://generativelanguage.googleapis.com/v1alpha',
    baseUrl: 'https://generativelanguage.googleapis.com/',
    apiVersion: 'v1alpha',
    why: 'a Google host whose whole path is a version',
  },
  {
    input: 'https://generativelanguage.googleapis.com/v1beta1/',
    baseUrl: 'https://generativelanguage.googleapis.com/',
    apiVersion: 'v1beta1',
    why: 'a trailing slash after the version',
  },
  {
    input: 'https://generativelanguage.mtls.googleapis.com/v1alpha',
    baseUrl: 'https://generativelanguage.mtls.googleapis.com/',
    apiVersion: 'v1alpha',
    why: 'the mutual-TLS host is a Google host too',
  },
  {
    input: 'http://generativelanguage.googleapis.com/v1',
    baseUrl: 'http://generativelanguage.googleapis.com/',
    apiVersion: 'v1',
    why: 'the scheme does not matter',
  },
  {
    input: 'https://generativelanguage.googleapis.com/',
    baseUrl: 'https://generativelanguage.googleapis.com/',
    apiVersion: undefined,
    why: 'a root path carries no version',
  },
  {
    input: 'https://generativelanguage.googleapis.com',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiVersion: undefined,
    why: 'an empty path carries no version',
  },
  {
    input: 'https://generativelanguage.googleapis.com/gemini/v1alpha',
    baseUrl: 'https://generativelanguage.googleapis.com/gemini/v1alpha',
    apiVersion: undefined,
    why: 'the version must be the whole path, not a suffix of it',
  },
  {
    input: 'https://proxy.example.com/v1alpha',
    baseUrl: 'https://proxy.example.com/v1alpha',
    apiVersion: undefined,
    why: 'a proxy owns its own path',
  },
  {
    input: 'https://generativelanguage.googleapis.com:8443/v1alpha',
    baseUrl: 'https://generativelanguage.googleapis.com:8443/v1alpha',
    apiVersion: undefined,
    why: 'a non-default port is not the documented Google endpoint',
  },
  {
    input: 'https://generativelanguage.googleapis.com/v1alpha?key=secret',
    baseUrl: 'https://generativelanguage.googleapis.com/v1alpha?key=secret',
    apiVersion: undefined,
    why: 'a query string must survive intact',
  },
  {
    input: 'https://generativelanguage.googleapis.com/v1alpha#frag',
    baseUrl: 'https://generativelanguage.googleapis.com/v1alpha#frag',
    apiVersion: undefined,
    why: 'a fragment must survive intact',
  },
  {
    input: 'generativelanguage.googleapis.com/v1alpha',
    baseUrl: 'generativelanguage.googleapis.com/v1alpha',
    apiVersion: undefined,
    why: 'a string that is not a URL is returned unchanged',
  },
  {
    input: 'https://generativelanguage.googleapis.com/version-one',
    baseUrl: 'https://generativelanguage.googleapis.com/version-one',
    apiVersion: undefined,
    why: 'a version must start with v and a digit',
  },
];

describe('normalizeBaseUrlAndApiVersion', () => {
  for (const testCase of CASES) {
    it(`returns ${testCase.apiVersion ?? 'no version'} for ${
      testCase.input ?? 'undefined'
    }: ${testCase.why}`, () => {
      expect(normalizeBaseUrlAndApiVersion(testCase.input)).toEqual({
        baseUrl: testCase.baseUrl,
        apiVersion: testCase.apiVersion,
      });
    });
  }
});
