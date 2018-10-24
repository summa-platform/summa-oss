/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import amqp from 'amqplib';
import _ from 'underscore';
// import logTaskAction from '../common/action_logging';
import Ajv from 'ajv';
import { fork } from 'child_process';
import { getTaskId } from '../common/task';
import { getTaskDebugFn } from '../common/debuggers';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
});

let debug;
let resultResponseProps;

const maxChildWorkTimeMs = 30 * 60 * 1000; // 30 min

const modulePath = './worker.js';
const stringArgsArray = [];
const childProcessOptions = {
  cwd: './app/task_worker_wrapper', // <String> Current working directory of the child process
  env: process.env, // <Object> Environment key-value pairs
  detached: true,
};

// separate process for each queue that is watched
const childProcessCache = { };
function startChildProcess(workerSpecPath, dataForEndpoint,
                           taskSpecificMetadata, taskQueueName) {
  return new Promise((resolve, reject) => {
    debug('setup child process');

    let childProcess;
    let childIdleKillTimout;
    const killChildProcess = (reason) => {
      debug(`[ERR] Killing child process because '${reason}'`);
      childProcess.kill();
      childProcessCache[taskQueueName] = null;
      clearTimeout(childIdleKillTimout);
      if (reason.errorType === 'maxIdleTimeExceeded') {
        taskDoneCalled = true;
        // create error object so that we get stack
        const err = Error(reason);
        reject({ message: reason, stack: err.stack });
      }
    };

    const resetChildIdleKillTimer = (reason) => {
      debug(`[INF] resetChildIdleKillTimer because '${reason}'`);
      clearTimeout(childIdleKillTimout);
      childIdleKillTimout = setTimeout(killChildProcess, maxChildWorkTimeMs, {
        errorType: 'maxIdleTimeExceeded',
        maxChildWorkTimeMs,
      });
    };

    if (!childProcessCache[taskQueueName]) {
      debug('** setup new child process');
      childProcessCache[taskQueueName] = fork(modulePath, stringArgsArray, childProcessOptions);
      childProcessCache[taskQueueName]
        .on('disconnect', () => debug('[INF] Child disconnect event'))
        .on('exit', () => debug('[INF] Child exit event'))
        .on('close', () => {
          debug('[INF] Child close event');
          // if (!taskDoneCalled) {
          //   taskDoneCalled = true;
          //   debug('[ERR] unexpectedChildProcessClose');
          //   console.error('[ERR] unexpectedChildProcessClose');
          //   reject(Error('unexpectedChildProcessClose'));
          // }
        })
        // .on('message', () => console.log('NT – child message event'))
        .on('error', () => {
          debug('[ERR] Child error event');
          console.error('[ERR] Child error event');
          clearTimeout(childIdleKillTimout);
          childProcessCache[taskQueueName].kill();
          childProcessCache[taskQueueName] = null;
          reject(Error('childProcessError'));
        });
    } else {
      debug('** reusing prev child process');
    }
    childProcess = childProcessCache[taskQueueName];
    childProcess.removeAllListeners('message');
    childProcess.on('message', (msgObj) => {
      // console.log('node-test child reported progress - reset kill timer', strMsg);
      if (msgObj.status === 'done') {
        clearTimeout(childIdleKillTimout);
        debug('[INF] got final result from child process');

        if (msgObj.err) {
          debug(`** child process reported error: ${msgObj.err}`);
          // create error object so that we get stack
          const err = Error(msgObj.err);
          reject({ message: msgObj.err, stack: err.stack });
          killChildProcess({ errorType: 'cleanupAfterPrevError' });
        } else {
          debug('** return child process result');
          resolve(msgObj.result);
        }
      } else if (msgObj.status === 'stillAlive') {
        resetChildIdleKillTimer(`childReportedProgress - '${JSON.stringify(msgObj)}'`);
      }
    });


    resetChildIdleKillTimer('child process started');
    childProcess.send({ workerSpecPath, dataForEndpoint, taskSpecificMetadata });
  });
}


const MESSAGE_QUEUE_HOST = 'amqp://job_queue?heartbeat=10'; // process.env.MESSAGE_QUEUE_HOST;
const RESULT_EXCHANGE_NAME = 'SUMMA-RESULTS'; // process.env.RESULT_EXCHANGE_NAME;


async function sendResult(channel, resultRoutingKeys, { resultType, resultData, taskMetadata }) {
  debug(`asserting exchange ${RESULT_EXCHANGE_NAME}`);
  // connect to the exchange
  await channel.assertExchange(RESULT_EXCHANGE_NAME, 'topic', { durable: false });

  // prepare payload
  // note thath the taskMetadata needs to come as is from the taskMessage
  const payload = new Buffer(JSON.stringify({
    resultType,
    resultData,
    taskMetadata,
  }));

  await channel.publish(
    RESULT_EXCHANGE_NAME,
    resultRoutingKeys[resultType],
    payload,
    resultResponseProps,
  );
}

async function processTask(taskRabbitMessage, channel, taskSpec, workerSpecPath, taskQueueName) {
  debug('\nprocessing task');
  const resultRoutingKeys = taskRabbitMessage.properties.headers.replyToRoutingKeys;

  let taskDataOrNull;
  let taskMetadataOrNull;
  try {
    // decode the message
    const {
      taskData, // the actual data for processing
      taskMetadata, // the task metadata that need to be past back with the result
    } = JSON.parse(taskRabbitMessage.content.toString('utf8'));
    taskDataOrNull = taskData;
    taskMetadataOrNull = taskMetadata;
  } catch (e) {
    console.log('[ERR] failed to decode message content');
  }

  let resultPayload;

  // FIXME should compile only once and pass in
  const validateDataForEndpoint = ajv.compile(taskSpec.workerSpec.inputSchema);
  if (!validateDataForEndpoint(taskDataOrNull)) {
    const validationErrors = validateDataForEndpoint.errors;
    resultPayload = {
      resultType: 'processingError',
      resultData: validationErrors,
    };
  } else {
    const taskData = taskDataOrNull; // reasign because we have validated
    debug('[INF] sending to processing in child process');
    // do processing in child process so that we can terminate it gracefully if it crashes or
    // time runs out
    try {
      const { taskSpecificMetadata } = taskMetadataOrNull;
      const taskFinalResult = await startChildProcess(workerSpecPath, taskData,
                                                      taskSpecificMetadata, taskQueueName);

      debug('[INF] received result from child process');
      resultPayload = {
        resultType: 'finalResult',
        resultData: taskFinalResult,
      };
    } catch (e) {
      debug('[ERR] caught exception from child process');
      resultPayload = {
        resultType: 'processingError',
        resultData: { message: e.message, stack: e.stack },
      };
    }
  }

  // debug('[INF] ack-ing rabbit msg');
  // try {
  //   await channel.ack(taskRabbitMessage);
  // } catch (e) {
  //   debug('[ERR] caught error while ack-ing rabbit msg');
  // }
  // debug('[INF] done');
  // return;

  try {
    // send result
    await sendResult(channel,
                     resultRoutingKeys,
                     { ...resultPayload, taskMetadata: taskMetadataOrNull });
  } catch (e) {
    console.log('[ERR] sending result', e);
    throw Error('problem sending result');
  }

  try {
    debug('ack-ing the task');
    channel.ack(taskRabbitMessage);
  } catch (e) {
    console.log('[ERR] ack-ing task', e);
    throw Error('problem ack-ing result');
  }
}


async function watchRouteQueue(conn, taskQueueName, taskSpec, workerSpecPath) {
  const channel = await conn.createConfirmChannel();
  debug(`created channel for queue ${taskQueueName}`);

  channel
    .on('error', (err) => {
      console.log('[ERR] channel error', taskQueueName, err);
      throw err;
    })
    .on('close', () => {
      console.log('[ERR] channel closed', taskQueueName);
      throw Error('MessageQueue channel closed');
    });

  channel.assertQueue(taskQueueName, { durable: false });
  // debug('task queue asserted');


  // don't dispatch a new message to a worker until it has
  // processed and acknowledged the previous one
  channel.prefetch(1);


  debug(`[*] waiting for tasks ${taskQueueName}`);
  channel.consume(
    taskQueueName,
    taskRabbitMessage => processTask(taskRabbitMessage, channel, taskSpec, workerSpecPath, taskQueueName),
    { noAck: false },
  );
}

async function start(workerSpecPath, taskSpec) {
  // setup debuggers
  debug = getTaskDebugFn(taskSpec.scriptPath);
  childProcessOptions.env.debugNamespace = debug.namespace;

  // setup global response props
  resultResponseProps = {
    headers: {
      resultProducerName: `${taskSpec.taskName}-${taskSpec.taskVersion}`,
    },
  };

  try {
    // establish connection to message queue
    debug('Connecting to the MessageQueue');
    const conn = await amqp.connect(MESSAGE_QUEUE_HOST);
    debug('connection established');


    conn
      .on('error', (err) => {
        console.log('[ERR] connection error', err);
        throw err;
      })
      .on('close', () => {
        console.log('[ERR] connection closed');
        throw Error('MessageQueue connection closed');
      });


    // override needed when different task_producers send tasks to the same workers
    // but result writers still need to be specific to the taskSpec that produced them
    const taskQueueBaseName = taskSpec.resultExchangeNameOverride || taskSpec.exchangeName;
    const queueNamesToWatch = _.isEmpty(taskSpec.routingKeys)
      ? [taskQueueBaseName]
      : taskSpec.routingKeys.map(routingKey => `${taskQueueBaseName}.${routingKey}`);
    queueNamesToWatch
      .forEach(taskQueueName => watchRouteQueue(conn, taskQueueName, taskSpec, workerSpecPath));
  } catch (error) {
    // something went wrong with creating channel or asserting queue
    // FIXME decide how to recover from that...
    //       currently throwing error so that master restarts the worker
    debug('[WARN] MessageQueue error', error);
    // trick to throw error from promise catch;
    // source http://stackoverflow.com/a/30741722
    setTimeout(() => {
      throw error;
    });
  }
}

export default { start };
