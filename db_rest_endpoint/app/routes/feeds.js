/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import { Router } from 'express';
import Ajv from 'ajv';
import _ from 'underscore';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';
import { hourInSeconds, getFormatedNewsItems, getHourOffsetBin } from '../common/utils.js';
import config from '../config.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});

// Feedtypes
// {label, internalval}
const feedTypes = [
  { label: 'DW Endpoint', internalval: 'dwFeed' },
  { label: 'BBC Endpoint', internalval: 'bbcFeed' },
  { label: 'RSS Endpoint', internalval: 'rssFeed' },
  { label: 'Twitter Endpoint', internalval: 'twitterFeed' },
  { label: 'LV Endpoint', internalval: 'lvFeed' },
];

const createItemSchema = {
  title: 'feed schema',
  type: 'object',
  required: [
    'name',
    'feedType',
    'url',
  ],
  additionalProperties: true,
  properties: {
    name: {
      // for gui and statistics
      description: 'name of the feed',
      type: 'string',
    },
    feedType: {
      description: 'type of the feed',
      type: 'string',
      enum: _.map(feedTypes, feedType => feedType.internalval),
    },
    url: {
      description: 'url to list of items',
      type: 'string',
    },
    feedGroups: {
      description: 'list with feedGroup ids',
      type: 'array',
      items: {
        description: 'feed group id',
        type: 'string',
      },
    },
  },
};
const updateItemSchema = { ...createItemSchema, required: undefined };

const validateCreateItem = ajv.compile(createItemSchema);
const validateUpdateItem = ajv.compile(updateItemSchema);

export default (r, topLevelPath) => {
  const router = new Router();

  const table = r.table('feeds');

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

  const getFeedExtraFields = feed => ({
    feedGroups: r.db(config.db.dbName)
        .table('feedGroups')
        .filter(feedGroup => feedGroup('feeds').contains(feed('id')))
        .pluck('id', 'name')
        .coerceTo('array'),
    status: 'Active', // TODO: calculate actual status
  });


  router.get('/feedTypes', (request, response) => {
    response.status(200) // 200 - ok
      .json(feedTypes);
  });

  router.get('/', (request, response, next) => {
    table
      .merge(getFeedExtraFields)
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
          message: 'Failed to get Feeds',
          description: err,
        });
        next();
      });
  });

  router.get('/:feedId', (request, response, next) => {
    const feedId = request.params.feedId;
    table
      .get(feedId)
      .do(item => r.branch(item, item.merge(getFeedExtraFields), item))
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
          message: `Failed to get Feed ${feedId}`,
          description: err,
        });
        next();
      });
  });

  router.get('/:feedId/trending', (request, response, next) => {
    const feedId = request.params.feedId;

    const currentTime = r.now();

    const currentNewsItems = r.table('newsItems')
    .between(
      [feedId, currentTime.sub(24 * hourInSeconds)],
      [feedId, currentTime],
      { index: 'feedId-TimeAdded' },
    );

    const query = r.expr({
      last24hStats: currentNewsItems
        .group(newsItem => getHourOffsetBin(r, currentTime, newsItem('timeAdded')))
        .ungroup()
        .map(group => [group('group'), group('reduction').count()])
        .coerceTo('object'),
      epochTimeSecs: currentTime.toEpochTime().round(),
    });

    query
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
          message: `Failed to get Feed ${feedId}`,
          description: err,
        });
        next();
      });
  });

  // /trending/mediaItemSelection?epochTimeSecs=<intSecs>&pastHourString=<-hString>
  router.get('/:feedId/trending/mediaItemSelection', (request, response, next) => {
    const feedId = request.params.feedId;
    const epochTimeSecs = request.query.epochTimeSecs || r.now().toEpochTime().coerceTo('string');
    const pastHourString = request.query.pastHourString || null;

    const time = r.epochTime(r.expr(epochTimeSecs).coerceTo('number'));

    const newsItemsInHour = r.table('newsItems')
      .between(
        [feedId, time.sub((-(pastHourString || '-24') + 1) * hourInSeconds)],
        [feedId, time],
        { index: 'feedId-TimeAdded' },
      )
      .filter(newsItem => getHourOffsetBin(r, time, newsItem('timeAdded')).eq(pastHourString));

    const query = r.expr({
      mediaItems: getFormatedNewsItems(r, newsItemsInHour),
    });

    query
      .run()
      .then((result) => {
        if (result === null) {
          response.status(404) // 404 – not found
            .json(result);
        } else {
          response.status(200) // 200 - ok
          .json(result);
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get newsItems for ${feedId}`,
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
      const feedData = _.omit(rawRequestContent, 'feedGroups');

      table
        .filter({ url: feedData.url })
        .count()
        .do(count => r.branch(
          count.eq(0),
          r.db(config.db.dbName)
            .table('feeds')
            .insert(feedData, { returnChanges: true })
            .do((result) => {
              const feed = result('changes')(0)('new_val');
              const feedId = result('generated_keys')(0);
              const feedGroupIds = r.expr(rawRequestContent.feedGroups || []);
              return r.table('feedGroups')
                .filter(feedGroup => feedGroupIds.contains(feedGroup('id')))
                .update(feedGroup => ({ feeds: feedGroup('feeds').setUnion([feedId]) }), { nonAtomic: true })
                .do(() => feed.merge(getFeedExtraFields(feed)));
            }),
          { status: 'already exists', currentValue: r.table('feeds').filter({ url: feedData.url })(0).coerceTo('object') },
        ))
        .run()
        .then((result) => {
          if (result.status === 'already exists') {
            reportError(response, {
              httpStatusCode: 409,
              message: `Feed with url '${feedData.url}' already exists`,
              description: result,
            });
          } else {
            response.status(201) // 201 – created
              .location(`${topLevelPath}/${result.id}`)
              .json(result);
          }
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
      const feedData = _.omit(rawRequestContent, 'feedGroups');

      const urlChangeRequest = _.has(feedData, 'url');
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
            table
            .filter({ url: feedData.url || item.url })
              .count()
              .do(count => r.branch(
                count.eq(urlChangeRequest && (feedData.url !== item.url) ? 0 : 1),
                table
                  .get(id)
                  .update(feedData, { returnChanges: 'always' })
                  .do((updateResult) => {
                    const feed = updateResult('changes')(0)('new_val');
                    const feedId = feed('id');
                    const feedGroupIds = r.expr(rawRequestContent.feedGroups || []);

                    return r.table('feedGroups')
                      .update(feedGroup => ({
                        feeds: r.branch(
                          // if new feedGroupIds contain feedGroupId
                          feedGroupIds.contains(feedGroup('id')),
                          // then add feed to it
                          feedGroup('feeds').setUnion([feedId]),
                          // else remove feed from it
                          feedGroup('feeds').setDifference([feedId])),
                      }))
                      .do(() => feed.merge(getFeedExtraFields(feed)));
                  }),
                {
                  status: 'already exists',
                  currentValue: table
                    .filter(feed => feed('url').eq(feedData.url || item.url).and(feed('id').eq(id).not()))
                    .coerceTo('array'),
                },
              ))
              .run()
              .then((result) => {
                if (result.status === 'already exists') {
                  reportError(response, {
                    httpStatusCode: 409,
                    message: `Feed with url '${feedData.url}' already exists`,
                    description: result,
                  });
                } else {
                  response.status(200) // 200 – ok
                    .json(result);
                }
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
        message: `Failed to delete Feed ${id}`,
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
          r.do(
            r.table('feedGroups')
             .update(feedGroup => ({ feeds: feedGroup('feeds').setDifference([id]) })),
            table.get(id).delete(),
          )
          .run()
          .then((deletionResult) => {
            console.log('feed deleted', deletionResult);
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
