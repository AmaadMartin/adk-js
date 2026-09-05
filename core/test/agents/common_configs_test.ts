/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {codeConfigSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';

function firstIssueMessage(result: {
  success: boolean;
  error?: {issues: Array<{message: string}>};
}): string {
  if (result.success || result.error === undefined) {
    expect.fail('expected the document to be rejected');
  }
  return result.error.issues[0].message;
}

describe('codeConfigSchema', () => {
  it('accepts a name', () => {
    expect(
      codeConfigSchema.parse({name: 'my_library.my_tools.my_tool'}),
    ).toEqual({name: 'my_library.my_tools.my_tool'});
  });

  it('requires a name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    const result = codeConfigSchema.safeParse({name: 'my_tool', args: {a: 1}});

    expect(firstIssueMessage(result)).toContain('args');
  });
});
