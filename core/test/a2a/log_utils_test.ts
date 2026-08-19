/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  FileWithUri,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';
import {
  buildA2ARequestLog,
  buildA2AResponseLog,
  buildMessagePartLog,
} from '../../src/a2a/log_utils.js';

const SEPARATOR = '-'.repeat(59);

/** A file reference that can point back at itself, to force a JSON cycle. */
interface SelfReferencingFile extends FileWithUri {
  self?: SelfReferencingFile;
}

/**
 * Builds an event the way the JSON-RPC transport does: the parsed response
 * body is used as-is, with no schema validation, so a field the protocol marks
 * required can still be missing.
 */
function parseWireEvent(payload: string): A2AEvent {
  return JSON.parse(payload);
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    kind: 'message',
    messageId: 'msg-1',
    role: 'user',
    parts: [{kind: 'text', text: 'hello'}],
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 'task-1',
    contextId: 'ctx-1',
    status: {state: 'working', timestamp: '2026-01-01T00:00:00Z'},
    ...overrides,
  };
}

/** Returns the lines of `log` between `heading` and the next separator. */
function sectionLines(log: string, heading: string): string[] {
  const lines = log.split('\n');
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf(SEPARATOR, start);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end);
}

describe('buildMessagePartLog', () => {
  it('renders a short text part in full', () => {
    const part: A2APart = {kind: 'text', text: 'Hello, world!'};

    expect(buildMessagePartLog(part)).toBe('TextPart: Hello, world!');
  });

  it('truncates a text part longer than 100 characters', () => {
    const part: A2APart = {kind: 'text', text: 'a'.repeat(150)};

    expect(buildMessagePartLog(part)).toBe(`TextPart: ${'a'.repeat(100)}...`);
  });

  it('does not truncate a text part of exactly 100 characters', () => {
    const part: A2APart = {kind: 'text', text: 'b'.repeat(100)};

    expect(buildMessagePartLog(part)).toBe(`TextPart: ${'b'.repeat(100)}`);
  });

  it('renders small data values unchanged', () => {
    const part: A2APart = {
      kind: 'data',
      data: {key1: 'value1', key2: 42, key3: null},
    };

    const log = buildMessagePartLog(part);

    expect(log).toContain('DataPart: ');
    expect(log).toContain('"key1": "value1"');
    expect(log).toContain('"key2": 42');
    expect(log).toContain('"key3": null');
  });

  it('summarizes data values that are too large to read', () => {
    const part: A2APart = {
      kind: 'data',
      data: {
        big_object: {note: 'x'.repeat(120)},
        big_array: Array.from({length: 60}, (_unused, i) => i),
        small_object: {ok: true},
        small_array: [1, 2, 3],
      },
    };

    const log = buildMessagePartLog(part);

    expect(log).toContain('"big_object": "<object>"');
    expect(log).toContain('"big_array": "<array>"');
    expect(log).toContain('"ok": true');
    expect(log).toContain('"small_array"');
    expect(log).not.toContain('xxxxx');
  });

  it('redacts the bytes of a file part', () => {
    const part: A2APart = {
      kind: 'file',
      file: {
        name: 'r.pdf',
        mimeType: 'application/pdf',
        bytes: 'QUJDREVGR0hJSks=',
      },
    };

    const log = buildMessagePartLog(part);

    expect(log).not.toContain('QUJDREVGR0hJSks=');
    expect(log).toContain('<bytes redacted>');
    expect(log).toContain('application/pdf');
    expect(log).toContain('r.pdf');
  });

  it('keeps the uri of a file part that carries no bytes', () => {
    const part: A2APart = {
      kind: 'file',
      file: {uri: 'https://example.com/r.pdf', mimeType: 'application/pdf'},
    };

    const log = buildMessagePartLog(part);

    expect(log).toContain('https://example.com/r.pdf');
    expect(log).not.toContain('<bytes redacted>');
  });

  it('does not mutate the file part it renders', () => {
    const part: A2APart = {
      kind: 'file',
      file: {name: 'r.pdf', bytes: 'QUJDREVGR0hJSks='},
    };

    buildMessagePartLog(part);

    expect(part).toEqual({
      kind: 'file',
      file: {name: 'r.pdf', bytes: 'QUJDREVGR0hJSks='},
    });
  });

  it('appends indented part metadata', () => {
    const part: A2APart = {
      kind: 'text',
      text: 'hello',
      metadata: {source: 'unit-test'},
    };

    const log = buildMessagePartLog(part);
    const [first, ...rest] = log.split('\n');

    expect(first).toBe('TextPart: hello');
    expect(rest[0]).toBe('    Part Metadata: {');
    expect(log).toContain('"source": "unit-test"');
    for (const line of rest) {
      expect(line.startsWith('    ')).toBe(true);
    }
  });

  it('omits the metadata section when metadata is empty', () => {
    const part: A2APart = {kind: 'text', text: 'hello', metadata: {}};

    expect(buildMessagePartLog(part)).toBe('TextPart: hello');
  });

  it('reports an unserializable data part instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const part: A2APart = {kind: 'data', data: {payload: cyclic}};

    expect(buildMessagePartLog(part)).toBe('DataPart: <unserializable>');
  });

  it('reports unserializable part metadata instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const part: A2APart = {kind: 'text', text: 'hello', metadata: cyclic};

    expect(buildMessagePartLog(part)).toBe(
      'TextPart: hello\n    Part Metadata: <unserializable>',
    );
  });

  it('reports an unserializable file part instead of throwing', () => {
    const file: SelfReferencingFile = {uri: 'https://example.com/loop'};
    file.self = file;
    const part: A2APart = {kind: 'file', file};

    expect(buildMessagePartLog(part)).toBe('FilePart: <unserializable>');
  });
});

describe('buildA2ARequestLog', () => {
  it('numbers every part and lists the message identifiers', () => {
    const log = buildA2ARequestLog(
      createMessage({
        taskId: 'task-1',
        contextId: 'ctx-1',
        parts: [
          {kind: 'text', text: 'first'},
          {kind: 'text', text: 'second'},
        ],
      }),
    );

    expect(log).toContain('A2A Send Message Request:');
    expect(log).toContain('  ID: msg-1');
    expect(log).toContain('  Role: user');
    expect(log).toContain('  Task ID: task-1');
    expect(log).toContain('  Context ID: ctx-1');
    expect(log).toContain('Part 0: TextPart: first');
    expect(log).toContain('Part 1: TextPart: second');
  });

  it('renders absent identifiers as undefined', () => {
    const log = buildA2ARequestLog(createMessage());

    expect(log).toContain('  Task ID: undefined');
    expect(log).toContain('  Context ID: undefined');
  });

  it('reports an empty parts list', () => {
    const log = buildA2ARequestLog(createMessage({parts: []}));

    expect(log).toContain('No parts');
  });

  it('renders message metadata exactly once', () => {
    const log = buildA2ARequestLog(
      createMessage({metadata: {msg_type: 'test', priority: 'high'}}),
    );

    expect(log).toContain('"msg_type": "test"');
    expect(log).toContain('"priority": "high"');
    expect(log.match(/^\s*Metadata:$/gm)).toHaveLength(1);
  });

  it('indents the continuation lines of a multi-line part', () => {
    const log = buildA2ARequestLog(
      createMessage({
        parts: [{kind: 'data', data: {alpha: 'one', beta: 'two'}}],
      }),
    );

    const partLines = sectionLines(log, 'Message Parts:');

    expect(partLines[0]).toBe('Part 0: DataPart: {');
    expect(partLines.length).toBeGreaterThan(1);
    for (const line of partLines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true);
    }
  });
});

describe('buildA2AResponseLog', () => {
  it('summarizes a task', () => {
    const log = buildA2AResponseLog(createTask());

    expect(log).toContain('Result Type: Task');
    expect(log).toContain('Task ID: task-1');
    expect(log).toContain('Context ID: ctx-1');
    expect(log).toContain('Status State: working');
    expect(log).toContain('Status Timestamp: 2026-01-01T00:00:00Z');
    expect(log).toContain('History Length: 0');
    expect(log).toContain('Artifacts Count: 0');
  });

  it('renders the status message of a task', () => {
    const log = buildA2AResponseLog(
      createTask({
        status: {
          state: 'input-required',
          message: createMessage({
            messageId: 'status-msg',
            role: 'agent',
            parts: [{kind: 'text', text: 'need more input'}],
          }),
        },
      }),
    );

    expect(sectionLines(log, 'Status Message:')).toEqual([
      'ID: status-msg',
      'Role: agent',
      'Task ID: undefined',
      'Context ID: undefined',
      'Message Parts:',
      'Part 0: TextPart: need more input',
    ]);
  });

  it('reports a task without a status message', () => {
    const log = buildA2AResponseLog(createTask());

    expect(sectionLines(log, 'Status Message:')).toEqual(['None']);
  });

  it('numbers the history messages and counts the artifacts of a task', () => {
    const log = buildA2AResponseLog(
      createTask({
        history: [
          createMessage({messageId: 'h1', parts: [{kind: 'text', text: 'q'}]}),
          createMessage({
            messageId: 'h2',
            role: 'agent',
            parts: [{kind: 'text', text: 'a'}],
          }),
        ],
        artifacts: [
          {artifactId: 'art-1', parts: [{kind: 'text', text: 'result'}]},
        ],
      }),
    );

    expect(log).toContain('History Length: 2');
    expect(log).toContain('Artifacts Count: 1');
    expect(sectionLines(log, 'History:')).toEqual([
      'Message 1:',
      '  ID: h1',
      '  Role: user',
      '  Task ID: undefined',
      '  Context ID: undefined',
      '  Message Parts:',
      '  Part 0: TextPart: q',
      'Message 2:',
      '  ID: h2',
      '  Role: agent',
      '  Task ID: undefined',
      '  Context ID: undefined',
      '  Message Parts:',
      '  Part 0: TextPart: a',
    ]);
  });

  it('reports a task with an empty history', () => {
    const log = buildA2AResponseLog(createTask({history: []}));

    expect(sectionLines(log, 'History:')).toEqual(['No history']);
  });

  it('renders task metadata', () => {
    const log = buildA2AResponseLog(
      createTask({metadata: {tenant: 'acme', retries: 2}}),
    );

    expect(log).toContain('Task Metadata:');
    expect(log).toContain('"tenant": "acme"');
    expect(log).toContain('"retries": 2');
  });

  it('renders a message result', () => {
    const log = buildA2AResponseLog(
      createMessage({
        messageId: 'msg-9',
        role: 'agent',
        taskId: 'task-9',
        contextId: 'ctx-9',
        parts: [{kind: 'text', text: 'done'}],
        metadata: {origin: 'remote'},
      }),
    );

    expect(log).toContain('Result Type: Message');
    expect(sectionLines(log, 'Result Details:')).toEqual([
      '  ID: msg-9',
      '  Role: agent',
      '  Task ID: task-9',
      '  Context ID: ctx-9',
      '  Message Parts:',
      '  Part 0: TextPart: done',
      '  Metadata:',
      '  {',
      '    "origin": "remote"',
      '  }',
    ]);
    expect(sectionLines(log, 'Status Message:')).toEqual(['None']);
    expect(sectionLines(log, 'History:')).toEqual(['No history']);
  });

  it('renders a status update event', () => {
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: 'task-2',
      contextId: 'ctx-2',
      final: false,
      status: {state: 'working'},
    };

    const log = buildA2AResponseLog(event);

    expect(log).toContain('Result Type: TaskStatusUpdateEvent');
    expect(sectionLines(log, 'Result Details:')).toEqual([
      'Task ID: task-2',
      'Context ID: ctx-2',
      'Status State: working',
      'Final: false',
    ]);
  });

  it('renders an artifact update event', () => {
    const event: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: 'task-3',
      contextId: 'ctx-3',
      artifact: {
        artifactId: 'art-3',
        parts: [{kind: 'text', text: 'chunk'}],
      },
    };

    const log = buildA2AResponseLog(event);

    expect(log).toContain('Result Type: TaskArtifactUpdateEvent');
    expect(sectionLines(log, 'Result Details:')).toEqual([
      'Task ID: task-3',
      'Context ID: ctx-3',
      'Artifact ID: art-3',
      'Parts Count: 1',
    ]);
  });

  it('reports a message that arrived without a parts array', () => {
    const log = buildA2AResponseLog(
      parseWireEvent('{"kind":"message","messageId":"m-1","role":"agent"}'),
    );

    expect(sectionLines(log, 'Result Details:')).toEqual([
      '  ID: m-1',
      '  Role: agent',
      '  Task ID: undefined',
      '  Context ID: undefined',
      '  Message Parts:',
      '  No parts',
    ]);
  });

  it('reports a status message that arrived without a parts array', () => {
    const log = buildA2AResponseLog(
      parseWireEvent(
        '{"kind":"status-update","taskId":"t-1","contextId":"c-1","final":true,' +
          '"status":{"state":"completed","message":{"kind":"message",' +
          '"messageId":"s-1","role":"agent"}}}',
      ),
    );

    expect(sectionLines(log, 'Status Message:')).toEqual([
      'ID: s-1',
      'Role: agent',
      'Task ID: undefined',
      'Context ID: undefined',
      'Message Parts:',
      'No parts',
    ]);
  });

  it('reports an artifact update that arrived without an artifact', () => {
    const log = buildA2AResponseLog(
      parseWireEvent(
        '{"kind":"artifact-update","taskId":"t-2","contextId":"c-2"}',
      ),
    );

    expect(sectionLines(log, 'Result Details:')).toEqual([
      'Task ID: t-2',
      'Context ID: c-2',
      'Artifact ID: undefined',
      'Parts Count: 0',
    ]);
  });

  it('reports an artifact that arrived without a parts array', () => {
    const log = buildA2AResponseLog(
      parseWireEvent(
        '{"kind":"artifact-update","taskId":"t-3","contextId":"c-3",' +
          '"artifact":{"artifactId":"a-3"}}',
      ),
    );

    expect(sectionLines(log, 'Result Details:')).toEqual([
      'Task ID: t-3',
      'Context ID: c-3',
      'Artifact ID: a-3',
      'Parts Count: 0',
    ]);
  });

  it('dumps an event whose kind it does not know', () => {
    const event = {kind: 'thought-update', taskId: 't-4'};

    const log = buildA2AResponseLog(event);

    expect(log).toContain('Result Type: Unknown');
    expect(sectionLines(log, 'Result Details:')).toEqual([
      'JSON Data: {"kind":"thought-update","taskId":"t-4"}',
    ]);
    expect(sectionLines(log, 'Status Message:')).toEqual(['None']);
    expect(sectionLines(log, 'History:')).toEqual(['No history']);
  });

  it('redacts file bytes carried by a history message', () => {
    const log = buildA2AResponseLog(
      createTask({
        history: [
          createMessage({
            parts: [
              {
                kind: 'file',
                file: {name: 'r.pdf', bytes: 'QUJDREVGR0hJSks='},
              },
            ],
          }),
        ],
      }),
    );

    expect(log).not.toContain('QUJDREVGR0hJSks=');
    expect(log).toContain('<bytes redacted>');
  });
});
