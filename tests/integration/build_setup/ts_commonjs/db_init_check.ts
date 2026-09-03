/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const {DatabaseSessionService} = require('@google/adk'); // eslint-disable-line @typescript-eslint/no-require-imports
const {MikroORM} = require('@mikro-orm/core'); // eslint-disable-line @typescript-eslint/no-require-imports

MikroORM.init = async () => {
  return {
    schema: {
      ensureDatabase: async () => {},
      updateSchema: async () => {},
    },
    em: {
      // The schema probe reads the metadata and events tables; an empty
      // database answers neither, so the fake rejects the way one does.
      getConnection: () => ({
        execute: async () => {
          throw new Error('no such table');
        },
      }),
      fork: () => ({
        findOne: async () => null,
        create: () => ({}),
        persist: () => ({flush: async () => {}}),
      }),
    },
  };
};

async function testInit() {
  try {
    const service = new DatabaseSessionService('sqlite://:memory:');
    await service.init();
    console.log('DYNAMIC_IMPORT_SUCCESS');
  } catch (e) {
    console.error('DYNAMIC_IMPORT_FAILED', e);
  }
}
testInit();
