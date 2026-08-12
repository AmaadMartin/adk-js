/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

/** The model used for internal simulator LLM calls when none is configured. */
export const DEFAULT_SIMULATION_MODEL = 'gemini-2.5-flash';

const MAX_INJECTED_LATENCY_SECONDS = 120;
const DEFAULT_THINKING_BUDGET = 10240;

/** Schema for an error injected into a simulated tool call. */
export const InjectedErrorSchema = z.object({
  /**
   * The HTTP error code to inject. Surfaces as `error_code` in the tool
   * response.
   */
  injectedHttpErrorCode: z.number().int(),
  /**
   * The error message to inject. Surfaces as `error_message` in the tool
   * response.
   */
  errorMessage: z.string(),
});

/** Schema for a single injection rule applied to a simulated tool. */
export const InjectionConfigSchema = z
  .object({
    /** The probability of applying this injection. */
    injectionProbability: z.number().default(1.0),
    /**
     * Only apply the injection when every entry here matches the tool call
     * arguments. When absent, the injection applies to every call.
     */
    matchArgs: z.record(z.string(), z.unknown()).optional(),
    /**
     * Latency to inject before returning. Note it may not be accurate when the
     * simulation runs as an after-tool callback.
     */
    injectedLatencySeconds: z
      .number()
      .max(MAX_INJECTED_LATENCY_SECONDS)
      .default(0),
    /** The seed making this injection's probability draw reproducible. */
    randomSeed: z.number().int().optional(),
    /** The error to return instead of calling the tool. */
    injectedError: InjectedErrorSchema.optional(),
    /** The response to return instead of calling the tool. */
    injectedResponse: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (config) =>
      (config.injectedError !== undefined) !==
      (config.injectedResponse !== undefined),
    {
      message:
        'Either injectedError or injectedResponse must be set, but not both, and not neither.',
    },
  );

/** The strategy used to mock a tool whose injections did not fire. */
export enum MockStrategy {
  MOCK_STRATEGY_UNSPECIFIED = 'MOCK_STRATEGY_UNSPECIFIED',
  /** Use the tool's declaration to mock its response. */
  MOCK_STRATEGY_TOOL_SPEC = 'MOCK_STRATEGY_TOOL_SPEC',
  /** @deprecated Use MOCK_STRATEGY_TOOL_SPEC with tracing input. */
  MOCK_STRATEGY_TRACING = 'MOCK_STRATEGY_TRACING',
}

/** Schema for the simulation configuration of a single tool. */
export const ToolSimulationConfigSchema = z
  .object({
    /** The name of the tool to simulate. */
    toolName: z.string(),
    /**
     * The injections to evaluate, in order. The first one that fires returns
     * immediately; the mock strategy applies when none does.
     */
    injectionConfigs: z.array(InjectionConfigSchema).default([]),
    /** The mock strategy to fall back on. */
    mockStrategyType: z
      .enum(MockStrategy)
      .default(MockStrategy.MOCK_STRATEGY_UNSPECIFIED),
  })
  .refine(
    (config) =>
      config.injectionConfigs.length > 0 ||
      config.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    {
      message:
        'If injectionConfigs is empty, mockStrategyType cannot be MOCK_STRATEGY_UNSPECIFIED.',
    },
  );

/** Schema for the configuration of an environment simulation. */
export const EnvironmentSimulationConfigSchema = z.object({
  /** The per-tool simulation configurations. Tool names must be unique. */
  toolSimulationConfigs: z
    .array(ToolSimulationConfigSchema)
    .min(1, 'toolSimulationConfigs must be provided.')
    .superRefine((configs, ctx) => {
      const seenToolNames = new Set<string>();
      for (const config of configs) {
        if (seenToolNames.has(config.toolName)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate toolName found: ${config.toolName}`,
          });
        }
        seenToolNames.add(config.toolName);
      }
    }),
  /** The model used for the internal simulator LLM calls. */
  simulationModel: z.string().default(DEFAULT_SIMULATION_MODEL),
  /** The generation config used for the internal simulator LLM calls. */
  simulationModelConfiguration: z
    .custom<GenerateContentConfig>(
      (value) => typeof value === 'object' && value !== null,
    )
    .default(() => ({
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: DEFAULT_THINKING_BUDGET,
      },
    })),
  /**
   * Tracing data (e.g. a prior agent run trace as a JSON string) giving
   * historical context to mock generation.
   */
  tracing: z.string().optional(),
  /**
   * Environment-specific data (e.g. a minimal database dump as a JSON string)
   * passed to mock strategies for contextual mock generation.
   */
  environmentData: z.string().optional(),
});

/** An error injected into a simulated tool call. */
export type InjectedError = z.infer<typeof InjectedErrorSchema>;

/** A single injection rule applied to a simulated tool. */
export type InjectionConfig = z.infer<typeof InjectionConfigSchema>;

/** The simulation configuration of a single tool. */
export type ToolSimulationConfig = z.infer<typeof ToolSimulationConfigSchema>;

/** The configuration of an environment simulation, as callers pass it. */
export type EnvironmentSimulationConfigInput = z.input<
  typeof EnvironmentSimulationConfigSchema
>;

/** The configuration of an environment simulation, with defaults applied. */
export type EnvironmentSimulationConfig = z.output<
  typeof EnvironmentSimulationConfigSchema
>;
