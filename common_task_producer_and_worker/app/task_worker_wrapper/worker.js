/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import url from 'url';
import path from 'path';
import debugConstructor from 'debug';
import { restCall } from '../common/restClient';

const debug = debugConstructor(`${process.env.debugNamespace}:childProc`);

function remoteRestEndpoint(taskSpec, dataForEndpoint, taskSpecificMetadata, taskDoneCallback) {
  // if recoveries fail, put task back with reporting error
  // validate response according to api json schema
  // if validation fails report error and put task back
  // extract new field value
  // if error report and put taks back
  // call taskDoneCallback with the result

  // call the enpoint with data
  //     recover from timeouts and connection errors for a couple of times
  try {
    const customizeUrlFn = taskSpec.workerSpec.endpointSpec.customizeUrlFn || (x => x);
    const address = url.format(customizeUrlFn(taskSpec.workerSpec.endpointSpec.url,
                                              taskSpecificMetadata));
    restCall(taskSpec.workerSpec.endpointSpec.url.callType || 'POST' , address, dataForEndpoint,
      (err, response, body) => {
        debug('[INF] remoteRestEndpoint response');
        // this callback will only be called when the request succeeded
        // or after maxAttempts or on error
        if (err) {
          taskDoneCallback(err);
        } else {
          // check http status code
          const result = body;
          taskDoneCallback(err, result);
        }
      },
    );
  } catch (unexpectedErr) {
    console.log('[ERR] unexpectedErr at remoteRestEndpoint', unexpectedErr);
    taskDoneCallback({ message: unexpectedErr.message, stack: unexpectedErr.stack });
  }
}


function localFnEndpoint(taskSpec, dataForEndpoint, taskSpecificMetadata, taskDoneCallback) {
  taskSpec.workerSpec.endpointSpec.fn(dataForEndpoint, taskDoneCallback);
}

// TODO:
//   - adde option for workerprocess to report progress so that it can reset timout
//   - take into account in step_spec

process.on('message', (msgObj) => {
  debug('[INF] received message');
  if (msgObj.workerSpecPath) {
    const workerSpecPath = msgObj.workerSpecPath;
    const scriptPath = path.join('../', workerSpecPath, 'step_specs');
    const taskSpec = require(scriptPath).default; // eslint-disable-line

    const dataForEndpoint = msgObj.dataForEndpoint;
    const taskSpecificMetadata = msgObj.taskSpecificMetadata;
    const taskDoneCallback = (err, result) => {
      debug('[INF] got task result, reporting to parent');
      process.send({
        status: 'done',
        err,
        result,
      });
    };

    debug('[INF] sending task to processing');

    switch (taskSpec.workerSpec.endpointSpec.endpointType) {
    case 'remoteRestfulEndpoint':
      debug('[INF] calling remoteRestfulEndpoint');
      remoteRestEndpoint(taskSpec, dataForEndpoint, taskSpecificMetadata, taskDoneCallback);
      break;
    case 'localFnEndpoint':
      debug('[INF] calling localFnEndpoint');
      localFnEndpoint(taskSpec, dataForEndpoint, taskSpecificMetadata, taskDoneCallback);
      break;
    case 'localStreamingFnEndpoint':
      debug('[INF] calling localStreamingFnEndpoint');
      taskDoneCallback('localStreamingFnEndpoint not implemented');
      break;
    default:
      debug(`[ERR] unsuported endpoint type '${taskSpec.workerSpec.endpointSpec.endpointType}'`);
      console.error('[ERR] unknown endpoint type');
      taskDoneCallback('unknown endpoint type');
    }
  } else {
    debug('[ERR] unexpected message structure:}');
    console.error('[ERR] unexpected message structure', msgObj);
    process.send({
      status: 'done',
      err: 'unexpected message structure',
      result: null,
    });
  }
});

debug('[INF] started');


process.on('uncaughtException', (unexpectedErr) => {
  debug(`[ERR] unexpected error:\n${JSON.stringify(unexpectedErr.stack, null, '  ')}`);
  console.error('[ERR] unexpected error');
  process.send({
    status: 'done',
    err: unexpectedErr.stack,
    result: null,
  });
  throw unexpectedErr;
});
