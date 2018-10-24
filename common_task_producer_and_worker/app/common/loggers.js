/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import request from 'requestretry';

export function logError({ message, severity, moduleName, extraDetails }, callback) {
  console.error(`[ERR] ${message} in ${moduleName}\n`, extraDetails);

  request({
    url: 'http://db_rest_endpoint/logMessages',
    json: true,

    method: 'POST',
    body: { message, severity, moduleName, extraDetails },

    // The below parameters are specific to request-retry
    maxAttempts: 5,   // (default) try 5 times
    retryDelay: 5000,  // (default) wait for 5s before trying again
    retryStrategy: request.RetryStrategies.HTTPOrNetworkError, // retry on 5xx or network errors
  }, (err, response, body) => {
    // this callback will only be called when the request succeeded or after maxAttempts or on error
    if (err) {
      console.error('[ERR] failed to report error',
                    err, response, body);
    }
    callback(err);
  });
}
