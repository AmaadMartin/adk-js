/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The deprecation warning fires when the module is evaluated, so every case
// loads the module through a reset module cache. That needs the concrete
// module specifier, not the `@google/adk` entry point.
import type {
  CrewaiToolConfig,
  CrewaiToolLike,
} from '../../src/tools/crewai_tool.js';

const echoTool: CrewaiToolLike = {
  name: 'Serper Dev Tool',
  run: (args: unknown) => args,
};

async function spyOnLoggerWarn() {
  const {logger} = await import('../../src/utils/logger.js');
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

describe('deprecated tools/crewai_tool path', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns that the module has moved', async () => {
    const warn = await spyOnLoggerWarn();

    await import('../../src/tools/crewai_tool.js');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('is moved to integrations/crewai'),
    );
  });

  it('re-exports the CrewaiTool class itself', async () => {
    await spyOnLoggerWarn();

    const shim = await import('../../src/tools/crewai_tool.js');
    const source = await import('../../src/integrations/crewai/crewai_tool.js');

    expect(shim.CrewaiTool).toBe(source.CrewaiTool);
  });

  it('re-exports a usable CrewaiTool', async () => {
    await spyOnLoggerWarn();
    const {CrewaiTool} = await import('../../src/tools/crewai_tool.js');

    const config: CrewaiToolConfig = {tool: echoTool};

    expect(new CrewaiTool(config).name).toBe('serper_dev_tool');
  });

  it('does not warn when @google/adk is imported', async () => {
    const warn = await spyOnLoggerWarn();

    await import('@google/adk');

    expect(warn).not.toHaveBeenCalled();
  });
});
