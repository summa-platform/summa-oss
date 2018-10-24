/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import amqp from 'amqplib';

// import logTaskAction from '../common/action_logging';
import Ajv from 'ajv';
import { taskMetadataSchema, getTaskId } from '../common/task';
import { updateItemInDB, saveItemErrorInDB, reportTaskProgress } from '../common/restClient';
import { getTaskDebugFn } from '../common/debuggers';

let debug;

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
});

// resultType - [workStarted, finalResult, error, partialResult]
// resultData - should validate against error def, or taskSpecific result schema
// optional - processingTimeMilisecs, percentCompleted, workerId
const resultPayloadSchema = {
  title: 'task result schema',
  type: 'object',
  required: [
    'resultType',
    'resultData',
    'taskMetadata',
  ],
  additionalProperties: false,
  properties: {
    resultType: {
      description: 'type of payload',
      type: 'string',
      enum: ['partialResult', 'finalResult', 'processingError'],
    },
    resultData: {
      description: 'the actual result data',
    },
    taskMetadata: taskMetadataSchema,
    processingTimeMilisecs: {
      description: 'how long it took for the server to get so far',
      type: 'number',
    },
    percentCompleted: {
      description: '0-100 how much work still remains',
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
    workerId: {
      description: 'unique id of the worker instance',
      type: 'string',
    },
  },
};

const rabbitMsgSchema = {
  title: 'task result schema',
  type: 'object',
  required: [
    'properties',
    'content',
  ],
  additionalProperties: true,
  properties: {
    properties: {
      description: 'the extra properties of the rabbit msg',
      type: 'object',
      required: ['headers'],
      additionalProperties: true,
      properties: {
        headers: {
          description: 'rabbit message headers',
          type: 'object',
          required: ['resultProducerName'],
          properties: {
            resultProducerName: {
              description: 'who produced the result',
              type: 'string',
            },
          },
        },
      },
    },
    content: {
      description: 'the actual content of the message, will be parsed and interpreted as json',
    },
  },
};

const validateRabbitMessage = ajv.compile(rabbitMsgSchema);
const validateResultPayloadSchema = ajv.compile(resultPayloadSchema);


const InfrastructureErrorType = 'InfrastructureError';
const EndpointErrorType = 'EndpointError';
const UpdateErrorType = 'UpdateError';
function reportError(taskSpec, error, errorType, itemId) {
  // ignore conflict errors for now
  if (error.body && error.body.message === 'Update failed hashes dont agree with current values') {
    // ignore conflict errors for now
  } else {
    console.error(`[ERR] ${taskSpec.taskName} encountered ${errorType} for item ${itemId}`, error);
  }
}

// used for reporting infrastructere errors that are not result specific
function reportInfrastructureError(error) {
  // TODO: need to add endpoint for reporting infrastructure errors
  console.error('[ERR] infrastructure error', error);
}

function saveFinalResult(taskSpec, handleError, resultData, taskMetadata, doneCallback) {
  const { itemId, dependencyFieldsHash, resultFieldName, taskSpecificMetadata } = taskMetadata;

  const validateResultFromEndpoint = ajv.compile(taskSpec.workerSpec.outputSchema);

  if (!validateResultFromEndpoint(resultData)) {
    console.error('[ERR] endpoint result schema validation failed', validateResultFromEndpoint.errors);
    // no point sending to endpoint because data does not conform
    const validationErrors = validateResultFromEndpoint.errors;

    handleError(validationErrors, EndpointErrorType);
    doneCallback();
  } else {
    debug('result schema validation ok');
    // extract new field value
    let fieldValue;
    let fieldValueErr;
    try {
      const resultDataTransformerFn = taskSpec.workerSpec.resultTransformerFn || (x => x);
      fieldValue = resultDataTransformerFn(resultData);
    } catch (e) {
      fieldValueErr = e;
    }
    if (!fieldValueErr) {
      if (taskSpec.workerSpec.dbUpdateFn) {
        // console.log('[INF] custom update db');
        taskSpec
          .workerSpec
          .dbUpdateFn(
            { itemId, dependencyFieldsHash, resultFieldName, fieldValue, taskSpecificMetadata },
            (dbUpdateErr) => {
              if (dbUpdateErr) {
                debug(`[INF] custom db update error for ${getTaskId(taskMetadata)}\n${JSON.stringify(dbUpdateErr, null, '  ')}`);
                // ignare hash constraint failures
                if (!(dbUpdateErr.body && dbUpdateErr.body.message === 'Update failed hashes dont agree with current values')) {
                  console.error(`[ERR] failed to save results to ${itemId} ${resultFieldName}`, JSON.stringify(dbUpdateErr));
                }
                handleError(dbUpdateErr, UpdateErrorType);
              } else {
                debug(`[INF] custom db update finished for ${getTaskId(taskMetadata)}`);
              }
              doneCallback();
            },
        );
      } else {
        // console.log('[INF] default update db');
        updateItemInDB(
          taskSpec, itemId, dependencyFieldsHash, resultFieldName, fieldValue,
          (updateError) => {
            if (updateError) {
              // failed to save results
              // ignare hash constraint failures
              if (!(updateError.body && updateError.body.message === 'Update failed hashes dont agree with current values')) {
                console.error(`[ERR] failed to save results to ${itemId} ${resultFieldName}`, JSON.stringify(updateError));
              }
              debug(`[ERR] default db update error for ${getTaskId(taskMetadata)}\n${JSON.stringify(updateError, null, '  ')}`);
              handleError(updateError, UpdateErrorType);
            } else {
              debug(`[INF] custom db update finished for ${getTaskId(taskMetadata)}`);
              debug(`[INF] MessageQueue ack done for ${getTaskId(taskMetadata)}`);
            }
            doneCallback();
          },
        );
      }
    } else {
      reportError(taskSpec, fieldValueErr, InfrastructureErrorType, itemId);
      doneCallback();
    }
  }
}


function saveResult(workerSpecPath, rabbitMsg, rabbitChann, taskSpec) {
  debug(' [x] Received msg from message queue');

  if (!validateRabbitMessage(rabbitMsg)) {
    console.log('[INF] rabbit result message schema validation failed', validateRabbitMessage.errors);
    // no point going further, because some data is missing
    const validationErrors = validateRabbitMessage.errors;

    reportInfrastructureError(validationErrors);
    rabbitChann.ack(rabbitMsg);
  } else {
    const { resultProducerName } = rabbitMsg.properties.headers;

    try {
      const resultPayload = JSON.parse(rabbitMsg.content.toString('utf8'));
      // reportTaskProgress(resultPayload);

      // validate result structure
      if (!validateResultPayloadSchema(resultPayload)) {
        console.log('[INF] result schema validation failed', validateResultPayloadSchema.errors);
        reportInfrastructureError({
          producer: resultProducerName,
          err: validateResultPayloadSchema.errors,
        });
        rabbitChann.ack(rabbitMsg);
      } else {
        const { resultType, resultData, taskMetadata } = resultPayload;
        const { itemId, dependencyFieldsHash, resultFieldName } = taskMetadata;

        // define producer specific error
        const handleError = async (err, errorType) => {
          // write error to item through rest api
          // saveItemErrorInDB(
          //   taskSpec, itemId, dependencyFieldsHash, resultFieldName, err,
          //   (updateError) => {
          //     if (updateError) {
          //       // failed to save results
          //       // console.error('[ERR] failed to save error', JSON.stringify(updateError));
          //       reportError(taskSpec, updateError, UpdateErrorType, itemId);
          //     } else {
          //       console.error('[INF] error saved');
          //     }
          //   });
          reportError(taskSpec, err, errorType, itemId);
        };


        // do specific tasks for each type of result type
        switch (resultType) {
        case 'partialResult':
          // savePartialResult();
          console.error('[ERR] partialResult save not implemented');
          break;

        case 'finalResult':
          saveFinalResult(
            taskSpec, handleError, resultData, taskMetadata, () => rabbitChann.ack(rabbitMsg),
          );
          break;

        case 'processingError':
          saveItemErrorInDB(
            taskSpec, itemId, dependencyFieldsHash,
            resultFieldName, resultData, () => rabbitChann.ack(rabbitMsg),
          );
          break;

        default:
          reportInfrastructureError({
            producer: resultProducerName,
            err: 'should newer encounter unknown result type',
          });
          break;
        }
      }
    } catch (err) {
      // FIXME report that taskResult is not valid
      // ack task so that it does not polute queue
      reportInfrastructureError({ producer: resultProducerName, err });
      rabbitChann.ack(rabbitMsg); // FIXME - should we reject?
    }
  }
}


const resultExchangeName = 'SUMMA-RESULTS';

async function start(workerSpecPath, taskSpec) {
  // setup debuggers
  debug = getTaskDebugFn(taskSpec.scriptPath);

  const host = process.env.MESSAGE_QUEUE_HOST;

  try {
    // connect to message queue
    const conn = await amqp.connect(host);

    // close connection when process exits
    process.once('SIGINT', () => conn.close());

    conn.on('error', (err) => {
      debug('rabbit connection error', err);
      // throwing error, so that we are restarted
      reportError(taskSpec, err, 'RabbitConnectionError');
      // throw err;
      process.exit();
    });


    const channel = await conn.createConfirmChannel();
    await channel.assertExchange(resultExchangeName, 'topic', { durable: false });


    // create queue for this particular taskSpec
    // start consuming from this queue
    const exchangeName = taskSpec.resultExchangeNameOverride || taskSpec.exchangeName;
    const taskSpecResultRoutingKey = `${resultExchangeName}.${exchangeName}`;
    const taskSpecResultQueueName = taskSpecResultRoutingKey;

    const queue = await channel.assertQueue(taskSpecResultQueueName, { durable: false });
    await channel.bindQueue(queue.queue, resultExchangeName, `${taskSpecResultRoutingKey}.finalResult`);
    await channel.bindQueue(queue.queue, resultExchangeName, `${taskSpecResultRoutingKey}.processingError`);
    // for now consume only finalResult and processingError
    // await channel.bindQueue(queue.queue, resultExchangeName, `${taskSpecResultRoutingKey}.partialResult`);

    channel.on('error', (err) => {
      debug('rabbit channel error', err);
      // throwing error, so that we are restarted
      reportError(taskSpec, err, 'RabbitChannelError');
      process.exit();
      // throw err;
    });

    // don't dispatch a new message to a worker until it has
    // processed and acknowledged the previous one
    await channel.prefetch(1);

    await channel.consume(
      taskSpecResultQueueName,
      resultRabbitMsg => saveResult(workerSpecPath, resultRabbitMsg, channel, taskSpec),
      { noAck: false },
    );

    debug('[*] Waiting for messages.');
  } catch (error) {
    // something went wrong with creating channel or asserting queue
    // FIXME decide how to recover from that...
    //       currently throwing error so that master restarts the worker
    console.error('[ERR] catching error', error);
    // trick to throw error from promise catch;
    // source http://stackoverflow.com/a/30741722
    // setTimeout(() => {
    //   throw error;
    // });
    process.exit();
  }
}


export default { start };
