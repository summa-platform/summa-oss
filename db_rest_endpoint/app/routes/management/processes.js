/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import { Router } from 'express';
import Ajv from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});


// FIXME: should add apiErrorCode
// see http://www.vinaysahni.com/best-practices-for-a-pragmatic-restful-api#errors
function reportError(response, { httpStatusCode, message, description, errors }) {
  response.status(httpStatusCode).json({
    message,
    description,
    errors,
  });
}

function formatValidationErrors(validationErrors) {
  return validationErrors.map(error => (
    {
      message: error.message,
      dataPath: error.dataPath,
      receivedData: error.data,
    }
  ));
}

const newProcessSchema = {
  title: 'Process is either top lever process or subprocess within a process, e.g. step worker',
  type: 'object',
  required: ['dockerServiceName', 'processType', 'processName', 'processId'],
  additionalProperties: false,
  properties: {
    dockerServiceName: {
      description: 'The name of the docker-compose service',
      type: 'string',
    },
    processType: {
      description: 'The type of the process – master or worker',
      type: 'string',
      enum: ['master', 'worker'],
    },
    processName: {
      description: 'The name of the process, e.g. step name',
      type: 'string',
    },
    processId: {
      description: 'The identifier of the process instance',
      type: 'string',
    },
    processStatus: {
      description: 'The status of the process',
      enum: ['ok', 'heartbeatLost', 'terminated'],
    },
    lastHeartbeat: {
      description: 'the latest time the process reported a heartbeat',
      type: 'string',
    },
    logs: {
      description: 'array with what has happened to the process',
      type: 'array',
      items: {
        type: 'object',
        required: ['logType'],
        additionalProperties: false,
        properties: {
          logType: {
            enum: ['processStarted', 'internalError', 'endpointError', 'prcessingItem'],
          },
          itemId: { },
          message: { },
        },
      },
    },
  },
};

const validateNewProcess = ajv.compile(newProcessSchema);

export default (r, topLevelPath) => {
  const router = new Router();

  router.get('/', (request, response, next) => {
    reportError(response, {
      httpStatusCode: 501,
      message: 'Getting all Processes currently not supported',
      description: '',
    });

    return next();
  });


  router.get('/:id', (request, response, next) => {
    const processId = request.params.id;
    r.table('processes')
      .get(processId)
      .run()
      .then(result => {
        if (result === null) {
          response.status(204) // 204 – no content
            .json(result);
        } else {
          response.json(result);
        }
      })
      .error(err => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Process ${processId}`,
          description: err,
        });
        next();
      });
  });


  router.post('/', (request, response, next) => {
    const requestNewProcess = request.body;

    if (!validateNewProcess(requestNewProcess)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateNewProcess.errors),
      });
    } else {
      // create the new document
      // transform all fields to extended structure

      const newProcess = {
        ...requestNewProcess,
        timeAdded: r.now(),
        lastHeartbeat: r.now(),
        processStatus: 'ok',
        logs: [{
          logType: 'processStarted',
        }],
      };

      // FIXME: to make this indempodent calculate id by hashing the content of object
      //        thus if the same object will be placed repeatedly it will be ok
      //        then only need to change the response code to 200 – ok

      r.table('processes')
        .insert(newProcess, { returnChanges: true })
        .run()
        .then(result => {
          let errorEncountered;
          try {
            console.assert(result.inserted === 1, 'must be exactly one change');
            console.assert(result.deleted === 0, 'should be no deletions');
            console.assert(result.replaced === 0, 'should be no replacements');
            console.assert(result.errors === 0, 'should be no internal errors');
            console.assert(result.skipped === 0, 'should be no skipped');
            console.assert(result.changes[0].new_val, 'new object must be returned');
            console.assert(result.changes[0].old_val === null,
                           'no existing object should be changed');
            console.assert(result.changes[0].new_val.id === result.generated_keys[0],
                           'generated key must match');
          } catch (err) {
            errorEncountered = true;
            reportError(response, {
              httpStatusCode: 500,
              message: 'Failed to create Process',
              description: err,
            });
            next();
          }

          if (!errorEncountered) {
            response.status(201) // 201 – created
              .location(`${topLevelPath}/${result.generated_keys[0]}`)
              .json(result.changes[0].new_val);
          }
        })
        .error(err => {
          reportError(response, {
            httpStatusCode: 500,
            message: 'Failed to create Process',
            description: err,
          });
          next();
        });
    }
  });
};
