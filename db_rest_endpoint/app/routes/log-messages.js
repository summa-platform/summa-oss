/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import { Router } from 'express';
import Ajv from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
});

const logMessageSchema = {
  title: 'Log entry Schema',
  type: 'object',
  required: ['message', 'severity', 'moduleName'],
  additionalProperties: false,
  properties: {
    message: {
      description: 'log entry message',
      type: 'string',
    },
    severity: {
      description: 'How serere was the error',
      type: 'string',
      enum: ['non-recoverable', 'recoverable', 'warning'],
    },
    moduleName: {
      description: 'Name of the module that rised the error',
      type: 'string',
    },
    extraDetails: {
      description: 'Any extra details that could help with diagnostics',
    },
  },
};


const validateLogMessage = ajv.compile(logMessageSchema);


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


export default (r, topLevelPath) => {
  const router = new Router();

  //
  // api design guidelines taken from http://www.vinaysahni.com/best-practices-for-a-pragmatic-restful-api
  //

  // BASICS:
  // GET /news-items - Retrieves a list of news-items
  // GET /news-items/12 - Retrieves a specific news-item
  // POST /news-items - Creates a new news-item
  // PUT /news-items/12 - Updates news-item #12
  // PATCH /news-items/12 - Partially updates news-item #12
  // DELETE /news-items/12 - Deletes news-item #12

  // SELECTING FIELDS
  // Use a fields query parameter that takes a comma separated list of fields to include.
  // GET /tickets?fields=id,subject,customer_name,updated_at&state=open&sort=-updated_at

  // Updates & creation should return a resource representation
  // A PUT, POST or PATCH call may make modifications to fields of the underlying resource
  // that weren't part of the provided parameters
  // (for example: created_at or updated_at timestamps).
  // To prevent an API consumer from having to hit the API again for an updated representation,
  // have the API return the updated (or created) representation as part of the response.
  //
  // In case of a POST that resulted in a creation, use a HTTP 201 status code and include
  // a Location header that points to the URL of the new resource.

  // JSON encoded POST, PUT & PATCH bodies
  // An API that accepts JSON encoded POST, PUT & PATCH requests should also require
  // the Content-Type header be set to application/json or
  // throw a 415 Unsupported Media Type HTTP status code.


  router.get('/', (request, response, next) => {
    reportError(response, {
      httpStatusCode: 501,
      message: 'Getting all Log Messages currently not supported',
      description: '',
    });

    return next();
  });


  router.get('/:id', (request, response, next) => {
    reportError(response, {
      httpStatusCode: 501,
      message: 'Getting specific Log Messages currently not supported',
      description: '',
    });

    return next();
  });


  router.post('/', (request, response, next) => {
    const requestedLogMessageContent = request.body;

    if (!validateLogMessage(requestedLogMessageContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateLogMessage.errors),
      });
    } else {
      // create the new document
      const logMessage = {
        ...requestedLogMessageContent,
        timeReceived: new Date(),
      };

      r.table('logMessages')
        .insert(logMessage, { returnChanges: true })
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
              message: 'Failed to create LogMessage',
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
            message: 'Failed to create LogMessage',
            description: err,
          });
          next();
        });
    }
  });


  return router;
};
