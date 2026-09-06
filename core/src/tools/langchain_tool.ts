/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @deprecated The LangChain adapter moved to the langchain integration. Import
 * {@link LangchainTool} from `@google/adk` instead. This module re-exports it
 * so an existing import keeps working, and warns once when it is evaluated.
 */

import {logger} from '../utils/logger.js';

export {
  isLangchainToolLike,
  LangchainTool,
} from '../integrations/langchain/langchain_tool.js';
export type {
  LangchainToolConfig,
  LangchainToolLike,
  LangchainToolOptions,
} from '../integrations/langchain/langchain_tool.js';

const DEPRECATION_MESSAGE =
  '@google/adk/tools/langchain_tool is deprecated: LangchainTool has moved to ' +
  'the langchain integration. Import it from "@google/adk" instead.';

logger.warn(DEPRECATION_MESSAGE);
