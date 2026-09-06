/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/eventarc/test_config.py`, read at `a3bd1115`
 * on `main`. Each ported `it` keeps its Python name.
 *
 * `test_invalid_config` is not ported: it asserts that pydantic rejects
 * `project_id=123`. `EventarcToolConfig` is a TypeScript interface, so the
 * compiler makes that assertion and there is no runtime validator to raise.
 */

import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  EventarcToolset,
  type EventarcToolConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('EventarcToolConfig', () => {
  it('test_valid_config', () => {
    const config: EventarcToolConfig = {projectId: 'my-project'};
    expect(config.projectId).toBe('my-project');

    const config2: EventarcToolConfig = {};
    expect(config2.projectId).toBeUndefined();
    expect(config2.publishTimeoutMs).toBeUndefined();
  });

  it('spells the default timeout as the 15 seconds adk-python uses', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15_000);
  });

  it('leaves the toolset with an empty config when none is given', () => {
    const toolset = new EventarcToolset();

    expect(toolset.toolConfig).toEqual({});
    expect(toolset.credentialsConfig).toEqual({});
  });
});
