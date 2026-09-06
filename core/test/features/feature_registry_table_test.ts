/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureConfig,
  FeatureName,
  FeatureStage,
  getFeatureConfig,
  registerFeature,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * The stage and default of every registered feature, transcribed from
 * adk-python src/google/adk/features/_feature_registry.py at commit
 * 93cd316a9fc757a9025d5ab0f90d5b358ec8e5ca (google/adk-python main).
 *
 * Python names its MCP kill-switch `_MCP_GRACEFUL_ERROR_HANDLING`; adk-js
 * declares the same flag without the underscore, so the two enums differ in
 * member name but agree on every string value.
 */
const EXPECTED_FEATURES: ReadonlyArray<[FeatureName, FeatureStage, boolean]> = [
  [FeatureName.AGENT_CONFIG, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.AGENT_STATE, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.AUTHENTICATED_FUNCTION_TOOL, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.BASE_AUTHENTICATED_TOOL, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.BIG_QUERY_TOOLSET, FeatureStage.STABLE, true],
  [FeatureName.BIG_QUERY_TOOL_CONFIG, FeatureStage.STABLE, true],
  [FeatureName.BIGTABLE_TOOL_SETTINGS, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.BIGTABLE_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.COMPUTER_USE, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.DATA_AGENT_TOOL_CONFIG, FeatureStage.STABLE, true],
  [FeatureName.DATA_AGENT_TOOLSET, FeatureStage.STABLE, true],
  [FeatureName.DYNAMIC_INSTRUCTION_ROUTING, FeatureStage.EXPERIMENTAL, false],
  [FeatureName.DAYTONA_ENVIRONMENT, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.E2B_ENVIRONMENT, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.ENVIRONMENT_SIMULATION, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.EVENTARC_TOOL_CONFIG, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.EVENTARC_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.FALLBACK_MODEL, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.GCS_ADMIN_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.GCS_TOOL_SETTINGS, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.GCS_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.GOOGLE_CREDENTIALS_CONFIG, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.GOOGLE_TOOL, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.MCP_AGENT_SERVER, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.MCP_GRACEFUL_ERROR_HANDLING, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.PROGRESSIVE_SSE_STREAMING, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.PUBSUB_TOOL_CONFIG, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.PUBSUB_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.SKILL_TOOLSET, FeatureStage.STABLE, true],
  [FeatureName.SPANNER_ADMIN_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.SPANNER_TOOLSET, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.SPANNER_TOOL_SETTINGS, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.SPANNER_VECTOR_STORE, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.TOOL_CONFIG, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.TOOL_CONFIRMATION, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.PLUGGABLE_AUTH, FeatureStage.EXPERIMENTAL, true],
  [FeatureName.SNAKE_CASE_SKILL_NAME, FeatureStage.EXPERIMENTAL, false],
  [FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY, FeatureStage.WIP, false],
];

describe('feature registry table', () => {
  it('declares exactly the features adk-python declares', () => {
    expect(Object.values(FeatureName)).toHaveLength(EXPECTED_FEATURES.length);
    expect(EXPECTED_FEATURES).toHaveLength(39);
  });

  it.each(EXPECTED_FEATURES)(
    '%s is registered as %s, default %s',
    (featureName, stage, defaultOn) => {
      expect(getFeatureConfig(featureName)).toEqual({stage, defaultOn});
    },
  );

  it('names every member after its string value', () => {
    for (const [memberName, value] of Object.entries(FeatureName)) {
      expect(value).toBe(memberName);
    }
  });

  it('defaults defaultOn to false when registerFeature omits it', () => {
    const name = 'DEFAULT_ON_OMITTED' as FeatureName;
    const config: FeatureConfig = {stage: FeatureStage.WIP};

    registerFeature(name, config);

    expect(getFeatureConfig(name)?.defaultOn).toBe(false);
  });
});
