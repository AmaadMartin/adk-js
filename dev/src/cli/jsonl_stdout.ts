/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keeps stdout parseable while `--jsonl` is on.
 *
 * The records are not the only thing that reaches stdout. An agent loads its
 * own copy of `@google/adk`, whose logger this process cannot configure, and
 * that logger writes its warnings to stdout — a line that breaks a reader
 * parsing one JSON object per line. Raising the CLI's own log level does not
 * reach that copy.
 *
 * So for the length of a JSONL run every write to stdout is moved to stderr,
 * except the record lines themselves.
 */

/** Whether the write in flight is a record this module is emitting. */
let emittingRecord = false;

type StreamWrite = typeof process.stdout.write;
type WriteChunk = Parameters<StreamWrite>[0];
type WriteEncoding = Parameters<StreamWrite>[1];
type WriteCallback = Parameters<StreamWrite>[2];

/** Applies one write to `write`, honouring both of its call shapes. */
function forward(
  write: StreamWrite,
  chunk: WriteChunk,
  encoding?: WriteEncoding | WriteCallback,
  callback?: WriteCallback,
): boolean {
  return typeof encoding === 'function'
    ? write(chunk, encoding)
    : write(chunk, encoding, callback);
}

/**
 * Writes one JSONL record, the only thing allowed onto stdout.
 *
 * It goes to the stream directly rather than through `console.log`, so a test
 * that stubs the console cannot make a polluted stdout look clean.
 */
export function writeJsonlRecord(line: string): void {
  emittingRecord = true;
  try {
    process.stdout.write(`${line}\n`);
  } finally {
    emittingRecord = false;
  }
}

/**
 * Runs `body` with stdout reserved for JSONL records.
 *
 * @param body The run to guard.
 * @return Whatever `body` returned.
 */
export async function withJsonlStdout<T>(body: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write;
  const toStdout: StreamWrite = originalWrite.bind(process.stdout);
  const toStderr: StreamWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (
    chunk: WriteChunk,
    encoding?: WriteEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean =>
    forward(emittingRecord ? toStdout : toStderr, chunk, encoding, callback);

  try {
    return await body();
  } finally {
    process.stdout.write = originalWrite;
  }
}
