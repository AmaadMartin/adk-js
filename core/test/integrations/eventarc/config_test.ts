/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/eventarc/test_config.py`, read at `a3bd1115`
 * on `main`.
 *
 * Neither of its two tests is ported, because `EventarcToolConfig` is a
 * TypeScript interface: it has no runtime validator, no defaults and no
 * constructor. `test_invalid_config` asserts that pydantic rejects
 * `project_id=123`, and `test_valid_config` asserts that a valid config keeps
 * the fields it was given; the compiler makes both assertions. What is left to
 * test is the behaviour around the interface, which is below.
 */

import {DEFAULT_PUBLISH_TIMEOUT_MS, EventarcToolset} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('EventarcToolConfig', () => {
  it('spells the default timeout as the 15 seconds adk-python uses', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15_000);
  });

  it('leaves the toolset with an empty config when none is given', () => {
    const toolset = new EventarcToolset();

    expect(toolset.toolConfig).toEqual({});
    expect(toolset.credentialsConfig).toEqual({});
  });
});
