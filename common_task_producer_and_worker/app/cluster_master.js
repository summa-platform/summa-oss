/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import cluster from 'cluster';
import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import _ from 'underscore';

import { integrationDebug, getTaskDebugFn } from './common/debuggers';
import { logError } from './common/loggers';


function getDirectories(srcpath) {
  return fs.readdirSync(srcpath).filter(file => (
    fs.statSync(path.join(srcpath, file)).isDirectory()
  ));
}

const CustomSrcPath = '../steps/';


export default function startClusterMaster() {
  const STEP_TYPE = process.env.STEP_TYPE;

  try {
    expect(STEP_TYPE, 'STEP_TYPE')
      .to.be.oneOf(['TASK_PRODUCER', 'TASK_WORKER', 'TASK_TEST', 'RESULT_WRITER']);

    const activeStepListString = process.env.ACTIVE_STEPS;
    console.assert(activeStepListString, 'must supply active steps list');
    console.log('[INF] active steps:', activeStepListString);

    const tasks = activeStepListString.split(/;\s*/).filter(s => s.length > 0);
    const taskSrcDirs = getDirectories(path.join(__dirname, CustomSrcPath));
    const tasksWithoutSrc = _.difference(tasks, taskSrcDirs);
    console.assert(_.isEmpty(tasksWithoutSrc), `missing src for steps: [${tasksWithoutSrc}]`);

    const workerTasks = {};

    // if a worker encounters error that wont be helped with restarting
    // than it sends message to the master
    // so that master does not create new fork when the worke exits
    const unrecoverableTasks = {};

    const startWorker = (task) => {
      const taskPath = path.join(CustomSrcPath, task);
      const taskDebug = getTaskDebugFn(taskPath);
      const workerEnv = {
        WorkerTask: taskPath,
        STEP_TYPE,
        MESSAGE_QUEUE_HOST: process.env.MESSAGE_QUEUE_HOST,
        SUMMA_REST_ENDPOINT: process.env.SUMMA_REST_ENDPOINT,
        TASK_QUEUE_NAME: process.env.TASK_QUEUE_NAME,
        debugNamespace: taskDebug.namespace,
      };
      integrationDebug('[INF] Starting worker', workerEnv);
      const newWorker = cluster.fork(workerEnv);

      // Receive messages from this worker and handle them in the master process.
      newWorker.on('message', (msg) => {
        if (msg === 'unrecoverableErrorEncountered') {
          unrecoverableTasks[task] = true;
        }
      });

      workerTasks[newWorker.id] = task;
    };

    tasks.forEach(startWorker);


    cluster.on('online', (worker) => {
      integrationDebug(`[INF] Worker ${workerTasks[worker.id]}-${worker.id} reported is online`);
    });

    cluster.on('exit', (worker, code, signal) => { // (worker, code, signal)
      integrationDebug(`[INF] Worker ${workerTasks[worker.id]}-${worker.id} died`, code, signal);
      // console.log('Starting a new worker');

      // if the worker exited with notification that there is some
      // configuration error
      // than just log the error and dont restart
      const task = workerTasks[worker.id];

      if (!unrecoverableTasks[task]) {
        setTimeout(() => startWorker(task), 5 * 1000);
      } else {
        integrationDebug(`[ERROR] Worker ${workerTasks[worker.id]}-${worker.id} reported that no succesful restart is possible`);
        console.error(`[ERROR] Worker ${workerTasks[worker.id]}-${worker.id} reported that no succesful restart is possible`);
      }

      // cleanup
      delete workerTasks[worker.id];
    });
  } catch (unrecoverableError) {
    // somethingn went totally wrong
    // report unrecoverable error
    logError({
      message: 'unrecoverable error encountered',
      severity: 'non-recoverable',
      moduleName: `${STEP_TYPE} -- Master`,
      extraDetails: unrecoverableError,
    }, (err) => {
      if (err) {
        integrationDebug('[WARN] Failed to send Error message');
        console.error('Failed to send Error message');
      }
      process.exit();
    });
  }
}
