/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {sanitizeGeneratedFilePath} from '../../../src/built_in_agents/utils/path_normalizer.js';

describe('sanitizeGeneratedFilePath', () => {
  it.each([
    // Nothing to strip.
    ['tools/web.yaml', 'tools/web.yaml'],
    // Whole path wrapped in quotes, which would otherwise create a directory
    // literally named "'tools".
    ["'tools/web.yaml'", 'tools/web.yaml'],
    ['"tools/web.yaml"', 'tools/web.yaml'],
    ['`tools/web.yaml`', 'tools/web.yaml'],
    // Each segment quoted independently.
    ['"tools"/"web.yaml"', 'tools/web.yaml'],
    // Surrounding whitespace, including a stray newline.
    ['  agent.yaml\n', 'agent.yaml'],
    ['tools/ web.yaml', 'tools/web.yaml'],
    // Backslash separators are preserved as separators.
    ["'dir'\\'file.txt'", 'dir\\file.txt'],
    // A leading separator survives (empty first segment).
    ['/abs/path.txt', '/abs/path.txt'],
  ])('strips boundary noise from %j', (raw, expected) => {
    expect(sanitizeGeneratedFilePath(raw)).toBe(expected);
  });

  it('keeps interior quotes so real filenames survive', () => {
    expect(sanitizeGeneratedFilePath("my'file.yaml")).toBe("my'file.yaml");
    expect(sanitizeGeneratedFilePath("a/b'c/d.yaml")).toBe("a/b'c/d.yaml");
  });

  it('falls back to the trimmed input when every character is stripped', () => {
    expect(sanitizeGeneratedFilePath("'''")).toBe("'''");
    expect(sanitizeGeneratedFilePath('  ""  ')).toBe('""');
  });

  it('returns an empty string for blank input', () => {
    expect(sanitizeGeneratedFilePath('')).toBe('');
    expect(sanitizeGeneratedFilePath('   \t\n')).toBe('');
  });
});
