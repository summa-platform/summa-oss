/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import request from 'request';
import curlify from 'request-as-curl';
import urljoin from 'url-join';
import debugConstructor from 'debug';

const debug = debugConstructor(`${process.env.debugNamespace}:rest`);

// taken from http://stackoverflow.com/a/32749533
class ExtendableError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    this.message = message;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = (new Error(message)).stack;
    }
  }
}
class RestError extends ExtendableError {
  constructor(code, message, body, curl) {
    super(message);
    this.message = message;
    this.code = code;
    this.body = body;
    this.name = 'REST Error';
    this.curl = curl;
  }
}

// callback(err, response, body)
export function restCall(method, address, data, callback) {
  debug('[INF] making restCall', address);
  try {
    const req = request({
      url: address,
      json: true,
      method,
      body: data,
      timeout: 5 * 60 * 1000, // set timeout for rest call of 5 mins
    }, (err, response, body) => {
      debug('[INF] got restCall response');
      try {
        if (err) {
          debug('[INF] restCall error:', err);
          console.error('[ERR] encountered rest error for request', curlify(req.req, data), err);
          callback(err);
        } else if (response.statusCode >= 400) {
          const error = new RestError(response.statusCode, response.statusMessage,
            response.body, curlify(req.req, data));
          debug('[INF] response error:', err);
          callback(error);
        } else {
          callback(err, response, body);
        }
      } catch (unexpectedErr) {
        debug('[ERR] unexpected restCall response processing err', unexpectedErr);
        console.error('[ERR] unexpected restCall response processing err', unexpectedErr);
        callback(unexpectedErr);
      }
    });
  } catch (unexpectedErr) {
    debug('[ERR] unexpected restCall err', unexpectedErr);
    console.error('[ERR] unexpected restCall err', unexpectedErr);
    callback(unexpectedErr);
  }
}

export function reportTaskProgress(task) {
  const host = process.env.SUMMA_REST_ENDPOINT;
  const address = urljoin(host, 'taskProgress');
  restCall('POST', address, task, () => {});
}

export function sendDbUpdate(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
                             status, value, error, callback) { // eslint-disable-line
  const host = process.env.SUMMA_REST_ENDPOINT;
  const tableName = taskSpec.tableName;
  const address = urljoin(host, tableName, itemId);
  const patch = {
    status,
    value: error ? undefined : { [resultFieldName]: value },
    error,
    errorFieldName: resultFieldName,
    dependencyFields: taskSpec.fieldSpec[resultFieldName].dependencyFields,
    dependencyFieldsHash,
    updateType: 'set',
    source: taskSpec.taskName,
  };

  // console.log({ patches: [patch] });
  restCall('PATCH', address, { patches: [patch] }, callback);
  // restCall('PATCH', address, { patches: [patch] },
  //          (...args) => {
  //            reportTaskProgress({
  //              taskMetadata: { itemId, resultFieldName, tableName },
  //              reportData: args,
  //            });
  //            callback(...args);
  //          });
}

export function updateItemInDB(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
                               value, callback) { // eslint-disable-line
  const status = 'final';
  const error = undefined;
  sendDbUpdate(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
               status, value, error, callback);
}


export function saveItemErrorInDB(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
                                  error, callback) { // eslint-disable-line
  const status = 'error';
  const value = '';
  sendDbUpdate(taskSpec, itemId, dependencyFieldsHash, resultFieldName,
               status, value, error, callback);
}
