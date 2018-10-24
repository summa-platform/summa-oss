/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import { Router } from 'express';
import Ajv from 'ajv';
import _ from 'underscore';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});

const ratingTypes = [
  { label: 'Not Set', internalval: 'not-set' },
  { label: 'Thumbs Up', internalval: 'thumbs-up' },
  { label: 'Thumbs Down', internalval: 'thumbs-down' },
];


const createItemSchema = {
  title: 'feedback schema',
  type: 'object',
  required: [
    'user',
    'guiPath',
    'comment',
    'rating',
  ],
  additionalProperties: false,
  properties: {
    user: {
      description: 'id of the user',
      type: 'string',
    },
    guiPath: {
      description: 'the path in gui about which is the feedback',
      type: 'string',
    },
    comment: {
      description: 'freeform text for feedback',
      type: 'string',
    },
    rating: {
      description: 'rating – thumbs down/up/not-set',
      type: 'string',
      enum: _.map(ratingTypes, ratingType => ratingType.internalval),
    },
    screenshotBase64: {
      description: 'screenshot as base64 string',
      type: 'string',
    },
    metadata: {
      description: 'any extra values that might be useful',
      type: 'object',
    },
  },
};

const updateItemSchema = { ...createItemSchema, required: undefined };

const validateCreateItem = ajv.compile(createItemSchema);
const validateUpdateItem = ajv.compile(updateItemSchema);


export default (r, topLevelPath) => {
  const table = r.table('feedback');
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

  router.get('/ratingTypes', (request, response) => {
    response.status(200) // 200 - ok
      .json(ratingTypes);
  });

  router.get('/', (request, response, next) => {
    table
      .merge(feedback => ({
        user: r.table('users')
          .get(feedback('user'))
          .do(user => r.branch(user, { name: user('name'), id: user('id') }, user)),
      }))
      .without('screenshotBase64')
      .orderBy(r.desc('timeAdded'))
      .run()
      .then((result) => {
        response.status(200) // 200 – ok
          .json(result);
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get Feedbacks',
          description: err,
        });
        next();
      });
  });

  router.get('/:id', (request, response, next) => {
    const id = request.params.id;
    table
      .get(id)
      .do(feedback => (
        r.branch(feedback,
          feedback.merge({
            user: r.table('users')
              .get(feedback('user'))
              .do(user => r.branch(user, { name: user('name'), id: user('id') }, user)),
          }),
          feedback)
      ))
      .run()
      .then((result) => {
        if (result === null) {
          response.status(404) // 404 – not found
            .json(result);
        } else {
          response.status(200) // 200 – ok
            .json(result);
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Feedback ${id}`,
          description: err,
        });
        next();
      });
  });


  router.post('/', (request, response, next) => {
    const rawRequestContent = request.body;

    if (!validateCreateItem(rawRequestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateCreateItem.errors),
      });
    } else {
      table
        .insert({ ...rawRequestContent, timeAdded: r.now() }, { returnChanges: true })
        .run()
        .then((result) => {
          response.status(201) // 201 – created
            .location(`${topLevelPath}/${result.generated_keys[0]}`)
            .json(result.changes[0].new_val);
          next();
        })
        .error((err) => {
          reportError(response, {
            httpStatusCode: 500,
            message: 'Failed to create Feedback',
            description: err,
          });
          next();
        });
    }
  });


  router.patch('/:id', (request, response, next) => {
    const id = request.params.id;
    const rawRequestContent = request.body;

    const failedToUpdateDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to update Feedback ${id}`,
        description: dbErr,
      });
      next();
    };

    if (!validateUpdateItem(rawRequestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateUpdateItem.errors),
      });
      next();
    } else {
      table
        .get(id)
        .run()
        .then((item) => {
          if (item === null) {
            reportError(response, {
              httpStatusCode: 404, // 404 - Not Found
              message: `no Feedback with id ${id}`,
              errors: `no Feedback with id ${id}`,
            });
          } else {
            table
              .get(id)
              .update(rawRequestContent, { returnChanges: 'always' })
              .run()
              .then((result) => {
                response.status(200) // 200 – ok
                  .json(result.changes[0].new_val);
                next();
              });
          }
        })
        .error(failedToUpdateDbError);
    }
  });

  router.delete('/:id', (request, response, next) => {
    const id = request.params.id;

    const failedToDeleteItemDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to delete Feedback ${id}`,
        description: dbErr,
      });
      next();
    };

    table
      .get(id)
      .run()
      .then((item) => {
        if (item === null) {
          reportError(response, {
            httpStatusCode: 404, // 404 - Not Found
            message: `no Feedback with id ${id}`,
            errors: `no Feedback with id ${id}`,
          });
        } else {
          table.get(id).delete()
          .run()
          .then((deletionResult) => {
            console.log('Feedback deleted', deletionResult);
            response.sendStatus(204); // 204 - No Content
            next();
          })
          .error(failedToDeleteItemDbError);
        }
      })
      .error(failedToDeleteItemDbError);
  });


  return router;
};
