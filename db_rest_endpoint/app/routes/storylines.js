/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

import { Router } from 'express';
import Ajv from 'ajv';
import _ from 'underscore';
import { handlePatchRequest,
         createPatchDescriptionSchema,
         makeDataFieldValue } from '../common/summaDBUpdate.js';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});
// 'subStorylinesIncludingSelf',
const storylineSchema = {
  title: 'Storyline schema',
  type: 'object',
  required: ['label', 'source'],
  additionalProperties: false,
  properties: {
    label: {
      description: 'The label that could be used for the cluster',
      type: 'string',
    },
    newsItem: {
      description: 'The latest news item that should be added to the cluster',
      type: 'object',
      required: ['id', 'title', 'body', 'timeAdded'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        title: {
          description: 'title needed here because used in summarization',
          type: 'string',
        },
        body: {
          description: 'text used for storyline detection',
          type: 'string',
        },
        feedId: {
          description: 'the id of the feed from where the item came from; needed for query filtering',
          type: 'string',
        },
        entities: {
          description: 'list of namedEntity baseForms; needed for query filtering',
          type: 'array',
          items: {
            description: 'namedEntity baseForm',
            type: 'string',
          },
        },
        timeAdded: {
          description: 'time when the newsItem was added',
          type: 'string',
          format: 'date-time',
        },
        contentDetectedLangCode: {
          description: 'item language',
          type: 'string',
        },
        sourceItemType: {
          description: 'type of item',
          type: 'string',
        },
      },
    },
    source: {
      description: 'the source service of the cluster',
      type: 'string',
    },
    mergedStorylineIds: {
      description: 'array with storylineRemoteId that should be merged into the current',
      type: 'array',
      items: {
        type: 'string',
      },
    },
    highlightItems: {
      description: 'few sentences that summarize all the news items from the current storyline',
    },
  },
};

const validateStorylineUpdate = ajv.compile(storylineSchema);

const storylineChangableDataFields = _.keys(storylineSchema.properties);
const storylinePatchSchema = createPatchDescriptionSchema(storylineChangableDataFields,
                                                          storylineSchema);

const validatePatchDescription = ajv.compile(storylinePatchSchema);

const clearAllDataRequestSchema = {
  title: 'Request body schema for clear all data',
  type: 'object',
  required: [
    'IAmSure',
  ],
  additionalProperties: false,
  properties: {
    IAmSure: {
      description: 'property to ensure that you know what you are doing',
      type: 'boolean',
      enum: [true],
    },
  },
};
const validateClearAllDataRequest = ajv.compile(clearAllDataRequestSchema);

function newsItemsValueHash(r, newsItems) {
  const bodyList = newsItems
    .values()
    .map(newsItem => newsItem('body').default(null));
  return r.uuid(bodyList.toJsonString());
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
    r.table('storylines')
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
          message: 'Failed to get Storylines',
          description: err,
        });
        next();
      });
  });


  router.get('/:id', (request, response, next) => {
    const storylineId = request.params.id;
    r.table('storylines')
      .get(storylineId)
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
          message: `Failed to get Storyline ${storylineId}`,
          description: err,
        });
        next();
      });
  });


  router.put('/:id', (request, response, next) => {
    const storylineId = request.params.id;
    const requestedStorylineUpdateContent = request.body;

    const substorylineIds = requestedStorylineUpdateContent.mergedStorylineIds || [];

    if (!validateStorylineUpdate(requestedStorylineUpdateContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateStorylineUpdate.errors),
      });
    } else {
      // create or update storyline
      const newsItem = requestedStorylineUpdateContent.newsItem;

      r.table('storylines')
        .get(storylineId)
        .replace(storyline => (
          storyline
            // if the storyline doc doesn't exist, we create it using `default`
            .default({
              id: storylineId,
              subStorylinesIncludingSelf: [storylineId],
              newsItems: {},
              timeAdded: r.now(),
            })
            // add newsItem
            .merge(currentStoryline => (
              {
                newsItems: currentStoryline('newsItems').default({}).merge({
                  [newsItem.id]: {
                    id: newsItem.id,
                    title: newsItem.title,
                    body: newsItem.body,
                    timeAdded: new Date(newsItem.timeAdded),
                    timeAddedToStoryline: r.now(),
                  },
                }),
                label: requestedStorylineUpdateContent.label,
                summaPlatformProcessingMetadata: {
                  label: makeDataFieldValue(r, requestedStorylineUpdateContent.source,
                                            'final', requestedStorylineUpdateContent.label),
                  newsItems: {
                    ...makeDataFieldValue(r, 'autoMerge', 'final'),
                    valueHash: newsItemsValueHash(
                      r,
                      currentStoryline('newsItems')
                      .default({})
                      .merge({
                        [newsItem.id]: {
                          body: newsItem.body,
                        },
                      })),
                  },
                },
              }
            ))
            // gather merged storylines
            .do(currentStoryline => (
              r.branch(
                currentStoryline('subStorylinesIncludingSelf').default([]).count().le(1),
                currentStoryline,
                currentStoryline.merge({
                  subStorylinesIncludingSelf: currentStoryline('subStorylinesIncludingSelf')
                    .setUnion(
                      r.table('storylines')
                        .filter(potentialSubstorylines => (
                          r.expr(substorylineIds).contains(potentialSubstorylines('id'))),
                        )
                        .concatMap(subStoryline => subStoryline('subStorylinesIncludingSelf'))
                        .coerceTo('array'),
                    ),
                  newsItems: r.table('storylines')
                    .filter(potentialSubstorylines => (
                      r.expr(substorylineIds).contains(potentialSubstorylines('id'))),
                    )
                    .fold(currentStoryline('newsItems'), (acc, substoryline) => (
                      acc.merge(
                        substoryline('newsItems')
                        .values()
                        // merge in only newsItems that are not present or newer
                        .filter(subNewsItem => (
                          acc
                            .hasFields(subNewsItem('id'))
                            .not()
                            .or(subNewsItem('timeAddedToStoryline').ge(acc(subNewsItem('id'))('timeAddedToStoryline')))
                        ))
                        .map(subNewsItem => [subNewsItem('id'), subNewsItem])
                        .coerceTo('object'),
                      )
                    )),
                }),
              )
            ))
          ), { durability: 'soft', nonAtomic: true, returnChanges: 'always' })
        .run()
        .then((result) => {
          // console.log('[INF] Storyline PUT result', result);
          // there are three possible results
          // 1. the item was created - inserted = 1
          // 2. the item already existing and was changed - replaced = 1
          // 3. the requeste change is duplicate - unchanged = 1
          let errorEncountered;
          try {
            console.assert(result.inserted === 1 ||
                           result.replaced === 1 ||
                           result.unchanged === 1, 'unexpected result');
            console.assert(result.deleted === 0, 'should be no deletions');
            console.assert(result.errors === 0, 'should be no internal errors');
            console.assert(result.skipped === 0, 'should be no skipped');
            console.assert(result.changes[0].new_val, 'new object must be returned');
          } catch (err) {
            errorEncountered = true;
            reportError(response, {
              httpStatusCode: 500,
              message: 'Failed to create Storyline',
              description: err,
            });
            next();
          }

          if (!errorEncountered) {
            response.status(200).end(); // 200 – OK
            //  .location(`${topLevelPath}/${storylineId}`)
            //  .json(result.changes[0] && result.changes[0].new_val);
          }
        })
        .error((err) => {
          reportError(response, {
            httpStatusCode: 500,
            message: 'Failed to create Storyline',
            description: err,
          });
          next();
        });
    }
  });

  router.post('/removeAllItems', (request, response, next) => {
    const requestContent = request.body;

    if (!validateClearAllDataRequest(requestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateClearAllDataRequest.errors),
      });
    } else {
      r.table('storylines')
       .delete()
       .run()
       .then((result) => {
         let errorEncountered;
         try {
           console.assert(result.errors === 0, 'should be no internal errors');
         } catch (err) {
           errorEncountered = true;
           reportError(response, {
             httpStatusCode: 500,
             message: 'Failed to remove all items',
             description: err,
           });
           next();
         }

         if (!errorEncountered) {
           response.status(201) // 201 – created
             .json(result);
         }
       })
       .error((err) => {
         reportError(response, {
           httpStatusCode: 500,
           message: 'Failed to remove all items',
           description: err,
         });
         next();
       });
    }
  });

  router.patch('/:storylineId/newsItems/:newsItemId', (request, response, next) => {
    const storylineId = request.params.storylineId;
    const newsItemId = request.params.newsItemId;
    const newsItem = request.body;

    const table = r.table('storylines');
    const failedToUpdateDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to update Storyline ${storylineId}`,
        description: dbErr,
      });
      next();
    };


    table
      .get(storylineId)
      .run()
      .then((item) => {
        if (item === null) {
          reportError(response, {
            httpStatusCode: 404, // 404 - Not Found
            message: `no Storyline with id ${storylineId}`,
            errors: `no Storyline with id ${storylineId}`,
          });
        } else {
          table
            .get(storylineId)
            .update(
              storyline => storyline.merge({ newsItems: { [newsItemId]: newsItem } }),
              { durability: 'soft' },
            )
            .run()
            .then((result) => {
              response.status(200).end(); // 200 – ok
              //  .json(result.changes[0].new_val);
              // next();
            })
            .error(failedToUpdateDbError);
        }
      })
      .error(failedToUpdateDbError);
  });


  router.patch('/:id', (request, response, next) => {
    const tableName = 'storylines';
    handlePatchRequest(validatePatchDescription, r, topLevelPath,
                       tableName, request, response, next);
  });


  return router;
};
