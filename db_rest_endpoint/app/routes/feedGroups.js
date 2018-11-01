/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import { Router } from 'express';
import Ajv from 'ajv';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';
import config from '../config.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});


const createItemSchema = {
  title: 'feedGroup schema',
  type: 'object',
  required: [
    'name',
    'feeds',
  ],
  additionalProperties: false,
  properties: {
    name: {
      // for gui and statistics
      description: 'name of the feedGroup',
      type: 'string',
    },
    feeds: {
      description: 'list of feed ids',
      type: 'array',
      items: {
        description: 'feed id',
        type: 'string',
      },
    },
  },
};

const updateItemSchema = { ...createItemSchema, required: undefined };

const validateCreateItem = ajv.compile(createItemSchema);
const validateUpdateItem = ajv.compile(updateItemSchema);

export default (r, topLevelPath) => {
  const table = r.table('feedGroups');
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


  const getFeeds = feedGroup => ({
    feeds: r.db(config.db.dbName).table('feeds')
      .getAll(r.args(feedGroup('feeds').default([])))
      .merge({ status: 'Active' }) // TODO: calculate actual status
      .coerceTo('array'),
  });

  router.get('/', (request, response, next) => {
    table
      .merge(getFeeds)
      .run()
      .then((result) => {
        if (result === null) {
          response.status(204) // 204 – no content
            .json(result);
        } else {
          response.json(result);
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get FeedGroups',
          description: err,
        });
        next();
      });
  });

  router.get('/:feedGroupId', (request, response, next) => {
    const feedGroupId = request.params.feedGroupId;
    table
      .get(feedGroupId)
      .do(item => r.branch(item, item.merge(getFeeds), item))
      .run()
      .then((result) => {
        if (result === null) {
          response.status(404) // 404 - Not Found
            .json(result);
        } else {
          response.json(result);
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get FeedGroup ${feedGroupId}`,
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
        // TODO ignore nonexistant feed ids
        .insert(rawRequestContent, { returnChanges: true })
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
            message: 'Failed to create Feed',
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
        message: `Failed to update Feed ${id}`,
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
              message: `no feedGroup with id ${id}`,
              errors: `no feedGroup with id ${id}`,
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
        message: `Failed to delete FeedGroup ${id}`,
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
            message: `no feed with id ${id}`,
            errors: `no feed with id ${id}`,
          });
        } else {
          table.get(id).delete()
          .run()
          .then((deletionResult) => {
            console.log('feedGroup deleted', deletionResult);
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
