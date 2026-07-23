/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {beforeEach, describe, expect, it} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {createSession} from '../../../src/sessions/session.js';
import {ComputerUseTool} from '../../../src/tools/computer_use/computer_use_tool.js';

describe('ComputerUseTool', () => {
  let context: Context;
  beforeEach(() => {
    context = new Context({
      invocationContext: {
        session: createSession('test'),
      } as any,
    });
    context.functionCallId = 'test-call';
  });

  it('validates screen sizes during initialization', () => {
    const fn = async () => {};
    expect(
      () =>
        new ComputerUseTool({
          func: fn,
          screenSize: [0, 1080],
        }),
    ).toThrowError(/screenSize dimensions must be positive/);

    expect(
      () =>
        new ComputerUseTool({
          func: fn,
          screenSize: [1920, 1080],
          virtualScreenSize: [-1, 1000],
        }),
    ).toThrowError(/virtualScreenSize dimensions must be positive/);

    expect(
      () =>
        new ComputerUseTool({
          func: fn,
          screenSize: [1920] as any,
        }),
    ).toThrowError(/screenSize must be a tuple/);
  });

  it('normalizes coordinates correctly', async () => {
    let capturedArgs: any;
    const tool = new ComputerUseTool({
      func: async (args: any) => {
        capturedArgs = args;
      },
      screenSize: [1920, 1080],
    });

    await tool.runAsync({
      args: {x: 500, y: 500, destination_x: 1000, destination_y: 0},
      toolContext: context,
    });

    expect(capturedArgs).toEqual({
      x: 960,
      y: 540,
      destination_x: 1919, // 1000/1000 * 1920 is 1920, clamped to 1919
      destination_y: 0,
    });
  });

  it('normalizes camelCase variables correctly', async () => {
    let capturedArgs: any;
    const tool = new ComputerUseTool({
      func: async (args: any) => {
        capturedArgs = args;
      },
      screenSize: [1280, 800],
      virtualScreenSize: [2000, 2000],
    });

    await tool.runAsync({
      args: {destinationX: 1000, destinationY: 1000},
      toolContext: context,
    });

    expect(capturedArgs).toEqual({
      destinationX: 640,
      destinationY: 400,
      destination_x: 640,
      destination_y: 400,
    });
  });

  it('rejects unexpected non-numeric coordinates', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    await expect(
      tool.runAsync({
        args: {x: 'not a number'},
        toolContext: context,
      }),
    ).rejects.toThrowError(/coordinate must be numeric/);
  });

  it('handles result format converting to base64 properly', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        return {
          screenshot: new Uint8Array([72, 101, 108, 108, 111]), // "Hello"
          url: 'https://example.com',
        };
      },
      screenSize: [1920, 1080],
    });

    const response = await tool.runAsync({
      args: {},
      toolContext: context,
    });

    expect(response).toEqual({
      image: {
        mimetype: 'image/png',
        data: Buffer.from('Hello').toString('base64'),
      },
      url: 'https://example.com',
    });
  });

  it('implements safety decisions correctly for require_confirmation', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    const response = await tool.runAsync({
      args: {
        safetyDecision: {
          decision: 'require_confirmation',
          explanation: 'Safety first',
        },
      },
      toolContext: context,
    });

    expect((response as any).error).toMatch(/requires confirmation/);
  });

  it('rejects call if toolConfirmation is strictly unconfirmed', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    // Provide a mocked confirmation object that is rejected
    context.toolConfirmation = {confirmed: false, id: '1'} as any;

    const response = await tool.runAsync({
      args: {},
      toolContext: context,
    });

    expect((response as any).error).toMatch(/rejected/);
  });

  it('returns undefined for _getDeclaration()', () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
      name: 'click_at',
    });

    expect(tool._getDeclaration()).toBeUndefined();
  });

  it('adds safety_acknowledgement if confirmation is true', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        return {something: 'else'};
      },
      screenSize: [1920, 1080],
    });

    context.toolConfirmation = {confirmed: true} as any;

    const response = await tool.runAsync({
      args: {},
      toolContext: context,
    });

    expect((response as any).safety_acknowledgement).toBe('true');
  });

  it('provides a no-op processLlmRequest', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });
    const llmRequest = {} as any;
    await expect(
      tool.processLlmRequest({llmRequest, toolContext: context}),
    ).resolves.toBeUndefined();
  });

  it('handles screenshot base64 encode failure', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        return {screenshot: 123 as any};
      },
      screenSize: [1920, 1080],
    });
    const response = await tool.runAsync({args: {}, toolContext: context});
    expect(response).toBeDefined();
  });

  it('handles non-object response with confirmation', async () => {
    const tool = new ComputerUseTool({
      func: async () => 'raw string',
      screenSize: [1920, 1080],
    });
    context.toolConfirmation = {confirmed: true} as any;
    const response = await tool.runAsync({args: {}, toolContext: context});
    expect((response as any).safety_acknowledgement).toBe('true');
    expect((response as any).result).toBe('raw string');
  });

  it('rejects with error if func throws', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        throw new Error('func err');
      },
      screenSize: [1920, 1080],
    });
    await expect(
      tool.runAsync({args: {}, toolContext: context}),
    ).rejects.toThrowError('func err');
  });

  it('uses default hint if explanation is missing', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });
    await expect(
      tool.runAsync({
        args: {safetyDecision: {decision: 'require_confirmation'}},
        toolContext: context,
      }),
    ).resolves.toBeDefined();
  });

  it('validates empty name properly', () => {
    expect(
      () =>
        new ComputerUseTool({
          func: (() => {}) as any, // Anonymous without name
          name: '',
          screenSize: [1920, 1080],
        }),
    ).toThrowError('Tool name cannot be empty');
  });

  it('validates virtualScreenSize correctly', () => {
    expect(
      () =>
        new ComputerUseTool({
          func: async () => {},
          name: 'click_at',
          screenSize: [1920, 1080],
          virtualScreenSize: [] as any,
        }),
    ).toThrowError('virtualScreenSize must be a tuple');
  });

  it('rejects unexpected non-numeric y coordinates', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    await expect(
      tool.runAsync({
        args: {y: 'not a number'},
        toolContext: context,
      }),
    ).rejects.toThrowError(/y coordinate must be numeric/);
  });
});
