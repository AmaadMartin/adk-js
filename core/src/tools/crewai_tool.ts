/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @deprecated The CrewAI adapter moved to the crewai integration. Import
 * {@link CrewaiTool} from `@google/adk` instead. This module re-exports it so
 * an existing import keeps working, and warns once when it is evaluated.
 */

import {logger} from '../utils/logger.js';

export {
  CrewaiTool,
  isCrewaiToolLike,
} from '../integrations/crewai/crewai_tool.js';
export type {
  CrewaiToolConfig,
  CrewaiToolLike,
  CrewaiToolOptions,
} from '../integrations/crewai/crewai_tool.js';

const DEPRECATION_MESSAGE =
  '@google/adk/tools/crewai_tool is deprecated: CrewaiTool has moved to the ' +
  'crewai integration. Import it from "@google/adk" instead.';

logger.warn(DEPRECATION_MESSAGE);
