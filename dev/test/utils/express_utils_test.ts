/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger, LogLevel} from '@google/adk';
import express, {NextFunction, Request, Response} from 'express';
import {once} from 'node:events';
import {describe, expect, it} from 'vitest';

import {
  asyncHandler,
  errorHandler,
  errorStatus,
} from '../../src/utils/express_utils.js';

/** Records what the error middleware logs. */
class RecordingLogger implements Logger {
  readonly errors: string[] = [];

  setLogLevel(_level: LogLevel): void {}
  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  error(...args: unknown[]): void {
    this.errors.push(args.join(' '));
  }
}

/**
 * Runs `use` against a throwaway express app on an ephemeral port. The
 * utilities under test only mean anything inside express's own dispatch, so
 * the tests drive real requests rather than hand-built request objects.
 */
async function withApp(
  configure: (app: express.Express) => void,
  use: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  configure(app);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('expected the test server to be listening on a TCP port');
  }

  try {
    await use(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('asyncHandler', () => {
  it('sends a rejection to the error middleware', async () => {
    const logger = new RecordingLogger();

    await withApp(
      (app) => {
        app.get(
          '/boom',
          asyncHandler(() => Promise.reject(new Error('handler exploded'))),
        );
        app.use(errorHandler(logger));
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/boom`);

        expect(response.status).toBe(500);
        expect(((await response.json()) as {error: string}).error).toContain(
          'handler exploded',
        );
      },
    );

    expect(logger.errors).toHaveLength(1);
  });

  it('leaves a resolving handler alone', async () => {
    const logger = new RecordingLogger();

    await withApp(
      (app) => {
        app.get(
          '/ok',
          // The `return res.json(...)` shape twelve dev-server routes use: it
          // resolves to a `Response`, not to `void`.
          asyncHandler((req, res) => Promise.resolve(res.json({ok: true}))),
        );
        app.use(errorHandler(logger));
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/ok`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ok: true});
      },
    );

    expect(logger.errors).toHaveLength(0);
  });

  it('returns undefined so express sees a void-returning handler', async () => {
    let returnValue: unknown = 'not called';

    await withApp(
      (app) => {
        app.get('/void-contract', (req, res, next) => {
          returnValue = asyncHandler(() => Promise.resolve('ignored'))(
            req,
            res,
            next,
          );
          res.json({ok: true});
        });
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/void-contract`);
        expect(response.status).toBe(200);
      },
    );

    expect(returnValue).toBeUndefined();
  });
});

describe('errorStatus', () => {
  it('defaults to 500', () => {
    expect(errorStatus(new Error('boom'))).toBe(500);
  });

  it('defaults to 500 for a non-object error', () => {
    expect(errorStatus('boom')).toBe(500);
  });

  it('defaults to 500 for null', () => {
    expect(errorStatus(null)).toBe(500);
  });

  it('defaults to 500 when status is not a number', () => {
    expect(errorStatus(Object.assign(new Error('boom'), {status: '400'}))).toBe(
      500,
    );
  });

  it('defaults to 500 for a status outside the error range', () => {
    expect(errorStatus(Object.assign(new Error('boom'), {status: 200}))).toBe(
      500,
    );
    expect(errorStatus(Object.assign(new Error('boom'), {status: 600}))).toBe(
      500,
    );
  });

  it('keeps a client error status set by middleware', () => {
    expect(errorStatus(Object.assign(new Error('boom'), {status: 400}))).toBe(
      400,
    );
  });
});

describe('errorHandler', () => {
  it('declares four parameters so express treats it as error middleware', () => {
    expect(errorHandler(new RecordingLogger()).length).toBe(4);
  });

  it('keeps the status an express middleware error carries', async () => {
    await withApp(
      (app) => {
        app.use(express.json());
        app.post('/echo', (req, res) => {
          res.json(req.body);
        });
        app.use(errorHandler(new RecordingLogger()));
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/echo`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: '{not json',
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as {error: string}).error).toContain(
          'POST /echo',
        );
      },
    );
  });

  it('delegates the original error once the response has started', async () => {
    const logger = new RecordingLogger();
    const failure = new Error('too late');
    let delegated: unknown = 'not called';

    await withApp(
      (app) => {
        app.get(
          '/late-failure',
          asyncHandler((req, res) => {
            res.write('partial');
            return Promise.reject(failure);
          }),
        );
        app.use(errorHandler(logger));
        app.use(
          (err: unknown, req: Request, res: Response, next: NextFunction) => {
            delegated = err;
            next(err);
          },
        );
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/late-failure`);

        // The status line was already flushed, so the error cannot change it;
        // express destroys the socket instead, truncating the body.
        expect(response.status).toBe(200);
        await expect(response.text()).rejects.toThrow();
      },
    );

    expect(delegated).toBe(failure);
    expect(logger.errors[0]).toContain('too late');
  });
});
