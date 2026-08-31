/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';

logger.warn(
  '@google/adk/tools/crewai_tool is moved to integrations/crewai. Import ' +
    'CrewaiTool and CrewaiToolConfig from @google/adk instead.',
);

export {CrewaiTool} from '../integrations/crewai/crewai_tool.js';
export type {
  CrewaiToolConfig,
  CrewaiToolLike,
  CrewaiToolOptions,
} from '../integrations/crewai/crewai_tool.js';
