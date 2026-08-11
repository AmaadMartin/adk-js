/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePolicyEngine,
  createEvent,
  getAskUserConfirmationFunctionCalls,
  InMemoryPolicyEngine,
  PolicyCheckResult,
  PolicyOutcome,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  SecurityPlugin,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createTestContext, createTestTool} from './test_helpers.js';

const mockTool = createTestTool('dangerous_tool');

describe('SecurityPlugin', () => {
  describe('constructor', () => {
    it('should initialize with default InMemoryPolicyEngine', () => {
      const plugin = new SecurityPlugin();
      expect(plugin.name).toBe('security_plugin');
    });

    it('should accept a custom policy engine', () => {
      const customEngine: BasePolicyEngine = {
        evaluate: async () => ({outcome: PolicyOutcome.DENY}),
      };
      const plugin = new SecurityPlugin({policyEngine: customEngine});
      expect(plugin.name).toBe('security_plugin');
    });
  });

  describe('beforeToolCallback — ALLOW outcome', () => {
    it('should return undefined when policy allows the tool call', async () => {
      const plugin = new SecurityPlugin();
      const toolContext = createTestContext({functionCallId: 'fc-1'});

      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {query: 'test'},
        toolContext,
      });

      expect(result).toBeUndefined();
    });

    it('should return undefined on second call when state is ALLOW', async () => {
      const plugin = new SecurityPlugin();
      const toolContext = createTestContext({functionCallId: 'fc-1'});

      // First call sets state to ALLOW
      await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      // Second call with existing ALLOW state
      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      expect(result).toBeUndefined();
    });
  });

  describe('beforeToolCallback — DENY outcome', () => {
    it('should return error object when policy denies the tool call', async () => {
      const denyEngine: BasePolicyEngine = {
        evaluate: async () => ({
          outcome: PolicyOutcome.DENY,
          reason: 'Unauthorized operation',
        }),
      };
      const plugin = new SecurityPlugin({policyEngine: denyEngine});
      const toolContext = createTestContext({functionCallId: 'fc-deny'});

      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      expect(result).toBeDefined();
      expect((result as Record<string, unknown>)['error']).toContain(
        'Unauthorized operation',
      );
    });
  });

  describe('beforeToolCallback — CONFIRM outcome', () => {
    it('should return partial on first call and request confirmation', async () => {
      const confirmEngine: BasePolicyEngine = {
        evaluate: async () => ({
          outcome: PolicyOutcome.CONFIRM,
          reason: 'Needs approval',
        }),
      };
      const plugin = new SecurityPlugin({policyEngine: confirmEngine});
      const toolContext = createTestContext({functionCallId: 'fc-confirm'});

      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      const confirmationRequests = Object.values(
        toolContext.actions.requestedToolConfirmations,
      );
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>)['partial']).toBeDefined();
      expect(confirmationRequests).toHaveLength(1);
      expect(confirmationRequests[0].hint).toContain('dangerous_tool');
    });

    it('should return partial on second call when no toolConfirmation set', async () => {
      const confirmEngine: BasePolicyEngine = {
        evaluate: async () => ({
          outcome: PolicyOutcome.CONFIRM,
          reason: 'Needs approval',
        }),
      };
      const plugin = new SecurityPlugin({policyEngine: confirmEngine});
      const toolContext = createTestContext({functionCallId: 'fc-confirm-2'});

      // First call — sets state to CONFIRM
      await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      // Second call — state is CONFIRM but no toolConfirmation provided
      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      expect(result).toBeDefined();
      expect((result as Record<string, unknown>)['partial']).toBeDefined();
    });

    it('should return error when confirmation is rejected', async () => {
      const confirmEngine: BasePolicyEngine = {
        evaluate: async () => ({
          outcome: PolicyOutcome.CONFIRM,
          reason: 'Needs approval',
        }),
      };
      const plugin = new SecurityPlugin({policyEngine: confirmEngine});
      const toolContext = createTestContext({functionCallId: 'fc-confirm-3'});

      // First call — sets state to CONFIRM
      await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      // Second call — user rejected
      toolContext.toolConfirmation = new ToolConfirmation({confirmed: false});

      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      expect(result).toBeDefined();
      expect((result as Record<string, unknown>)['error']).toContain(
        'rejected',
      );
    });

    it('should return undefined and clear confirmation when confirmed', async () => {
      const confirmEngine: BasePolicyEngine = {
        evaluate: async () => ({
          outcome: PolicyOutcome.CONFIRM,
          reason: 'Needs approval',
        }),
      };
      const plugin = new SecurityPlugin({policyEngine: confirmEngine});
      const toolContext = createTestContext({functionCallId: 'fc-confirm-4'});

      // First call — sets state to CONFIRM
      await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      // Second call — user confirmed
      toolContext.toolConfirmation = new ToolConfirmation({confirmed: true});

      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext,
      });

      expect(result).toBeUndefined();
      expect(toolContext.toolConfirmation).toBeUndefined();
    });
  });

  describe('beforeToolCallback — missing functionCallId', () => {
    it('should check policy when functionCallId is undefined', async () => {
      const plugin = new SecurityPlugin();
      const ctxWithoutId = createTestContext();

      // Should not throw — policy check proceeds but state not stored
      const result = await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: ctxWithoutId,
      });

      // InMemoryPolicyEngine always ALLOWs, so undefined
      expect(result).toBeUndefined();
    });
  });

  describe('InMemoryPolicyEngine', () => {
    it('should always return ALLOW', async () => {
      const engine = new InMemoryPolicyEngine();
      const result: PolicyCheckResult = await engine.evaluate({
        tool: mockTool,
        toolArgs: {},
      });

      expect(result.outcome).toBe(PolicyOutcome.ALLOW);
    });
  });

  describe('getAskUserConfirmationFunctionCalls', () => {
    it('should return empty array for event with no content', () => {
      const event = createEvent({author: 'model'});
      const result = getAskUserConfirmationFunctionCalls(event);
      expect(result).toEqual([]);
    });

    it('should return empty array for event with no matching function calls', () => {
      const event = createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'other_func', args: {}}}],
        },
      });
      const result = getAskUserConfirmationFunctionCalls(event);
      expect(result).toEqual([]);
    });

    it('should return confirmation function calls', () => {
      const event = createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {hint: 'approve?'},
              },
            },
          ],
        },
      });
      const result = getAskUserConfirmationFunctionCalls(event);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe(REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);
    });

    it('should handle mixed function calls', () => {
      const event = createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'regular_func', args: {}}},
            {
              functionCall: {
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {},
              },
            },
            {
              functionCall: {
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {},
              },
            },
          ],
        },
      });
      const result = getAskUserConfirmationFunctionCalls(event);
      expect(result).toHaveLength(2);
    });

    it('should return empty array for event with non-functionCall parts', () => {
      const event = createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      const result = getAskUserConfirmationFunctionCalls(event);
      expect(result).toEqual([]);
    });
  });
});
