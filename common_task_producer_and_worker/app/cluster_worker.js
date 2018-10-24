import Kefir from 'kefir';

import jsonfile from 'jsonfile';
import rDash from 'rethinkdbdash';

import path from 'path';

import { expect } from 'chai';
import { validateTaskSpec } from './common/validators';

import { logError } from './common/loggers';

import taskProducer from './task_producer/task_producer';
import workerWrapper from './task_worker_wrapper/worker_wrapper';
import resultWriter from './result_writer/result_writer';


export default function startClusterWorker(workerSpecPath) {
  const STEP_TYPE = process.env.STEP_TYPE;

  let unrecoverableError;
  let taskSpec;

  try {
    const scriptPath = path.join(workerSpecPath, 'step_specs');
    taskSpec = require(scriptPath).default;

    // validate taskSpec
    validateTaskSpec(taskSpec);
    // add scriptPath to task spec; needed for better debugging messages
    taskSpec.scriptPath = scriptPath;
  } catch (err) {
    // report the error
    // exit with unrecoverable error
    unrecoverableError = err;
  }

  if (!unrecoverableError) {
    //
    // Config
    //
    const configFilePath = '/config/config.json';

    Kefir
      .fromNodeCallback(callback => (jsonfile.readFile(configFilePath, callback)))
      .onValue((config) => {
        if (STEP_TYPE === 'TASK_PRODUCER') {
          const dbConfig = config.db;
          const r = rDash({
            db: dbConfig.dbName,
            servers: [dbConfig],
            silent: true,
          });
          taskProducer.start(r, taskSpec);
        } else if (STEP_TYPE === 'TASK_WORKER') {
          workerWrapper.start(workerSpecPath, taskSpec);
        } else if (STEP_TYPE === 'TASK_TEST') {
          expect(taskSpec, 'taskSpec').to.have.property('testFn').with.a('function');
          taskSpec.testFn();
        } else if (STEP_TYPE === 'RESULT_WRITER') {
          resultWriter.start(workerSpecPath, taskSpec);
        } else {
          // exit with unrecoverable error
          const err = new Error(`[!ERR] Unknown STEP_TYPE: ${STEP_TYPE}`);
          throw err;
        }
      })
      .onError((err) => {
        console.log('[ERR] unexpected error; exiting to be restarted', err);
        process.exit();
      });
  } else {
    // report the enurecoverable error
    // exit cleanly
    logError({
      message: 'unrecoverable error encountered',
      severity: 'non-recoverable',
      moduleName: `${STEP_TYPE} -- ${workerSpecPath}`,
      extraDetails: unrecoverableError,
    }, (err) => {
      if (!err) {
        // if succeeded to report erro then no use restarting worker
        process.send('unrecoverableErrorEncountered');
      }
      process.exit();
    });
  }
}
