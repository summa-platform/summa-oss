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


function clearDbFields(r, tableName, fieldName, filterFn, actionDescriptionStr, response, next) {
  const query = r.table(tableName);
  filterFn(query)
    .replace(r.row.without({
      [fieldName]: true,
      summaPlatformProcessingMetadata: {
        [fieldName]: true,
      },
    }), { durability: 'soft' })
    .run()
    .then((result) => {
      let errorEncountered;
      try {
        console.assert(result.errors === 0, 'should be no internal errors');
      } catch (err) {
        errorEncountered = true;
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to ${actionDescriptionStr}`,
          description: err,
        });
        next();
      }

      if (!errorEncountered) {
        response.status(200) // 200 – ok
        .json({ changedItemCount: result.replaced });
      }
    })
    .error((err) => {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to ${actionDescriptionStr}`,
        description: err,
      });
      next();
    });
}


const newsItemSchema = {
  title: 'Logical News Item',
  type: 'object',
  required: [
    'feedURL',
    'sourceItemOriginFeedName',
    'sourceItemLangeCodeGuess', // mandatory only while we do not have a language detector
  ],
  patternRequired: ['(^sourceItemMainText$)|(^sourceItemVideoURL$)|(^sourceItemAudioURL$)'],
  additionalProperties: false,
  properties: {
    //
    // metadata
    feedURL: {
      description: 'the url of the feed from where this came from; must be in the feeds collection',
      type: 'string',
    },
    sourceItemOriginFeedName: {
      // for gui and statistics
      description: 'feed name from where the news item was gathered in english; e.g. dw-feed',
      type: 'string',
    },
    sourceItemType: {
      description: 'type of news item, e.g. video, audio, tweet',
      type: 'string',
    },
    sourceItemLangeCodeGuess: {
      // for statistics
      // https://en.wikipedia.org/wiki/ISO_639-1
      // optional – content will go through a language detection module
      description: 'the most likely language of the news item content in; ISO 639-1',
      type: 'string',
    },
    sourceItemDate: {
      description: 'the publishing date of the news item',
      type: 'string',
    },
    sourceItemIdAtOrigin: {
      description: 'the id of the source item in the origin',
      type: 'string',
    },
    customMetadata: {
      // for debugging and extensions
      description: 'arbitrary metadata from data puller; put here anything you want',
      type: 'object',
    },
    prevSourceItemIdAtOrigin: {
      description: 'the id of previous source item in the origin; used for prew/next navigation',
      type: ['string', 'null'],
    },

    //
    // textual content
    sourceItemTitle: {
      // -(MT)-> engTitle
      description: 'title of the news item in the original language; optional',
      type: 'string',
    },
    sourceItemMainText: {
      // -(MT)-> engMainText
      description: 'the main textual content of the news item in the original language; optional',
      type: 'string',
    },
    sourceItemTeaser: {
      // -(MT)-> engTeaser
      description: 'the teaser of the news item in the original language; optional',
      type: 'string',
    },
    sourceItemKeywords: {
      // -(MT)-> engKeywordList
      description: 'list of string keywords in the original language; optional',
      type: 'array',
      items: {
        type: 'string',
      },
    },


    //
    // multimedia conent
    sourceItemVideoURL: {
      // -(ASR)-> contentTranscribedMainText
      description: 'url of the video segment in the original language; optional',
      type: 'string',
    },
    sourceItemAudioURL: {
      // -(ASR)-> contentTranscribedMainText
      description: 'url of the audio segment in the original language; optional',
      type: 'string',
    },
    sourceItemPhotoURL: {
      // for gui
      description: 'url of the photo that accompanies the news item; optional',
      type: 'string',
    },


    //
    // intermediate processing results
    contentDetectedLangCode: {
      // used to select which NLP language specific module to use
      // TODO: currently one for all content
      //       maybe should be for each field (video, audio, title, mainText, teaser, ...)
      description: 'ISO 639-1 language code of the detected language',
      type: 'string',
      minLength: 2,
      maxLength: 2,
    },
    contentTranscribedMainText: {
      // -(punctuation)-> sourceItemMainText
      // transcript eventually will contains info about word timestamps; currently just string
      description: 'video or audio transcript',
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          description: 'vad segments with arrayes of word confidences and timestamps',
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['word', 'confidence', 'time', 'duration'],
              additionalProperties: false,
              properties: {
                word: { type: 'string' },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                },
                time: {
                  type: 'number',
                  minimum: 0,
                },
                duration: {
                  type: 'number',
                  minimum: 0,
                },
              },
            },
          },
        },
      },
    },
    contentTranscribedPunctuatedMainText: {
      // -(mt)-> engTranscript
      // -> sourceItemMainText
      // transcript eventually will contains info about word timestamps; currently just string
      description: 'video or audio transcript with punctuations',
      type: 'string',
    },


    //
    // eng textual content
    engTitle: {
      // translation to english will eventually contain word alignment info and timestamps;
      // currently just string
      description: 'english title',
      type: 'string',
    },
    engMainText: {
      // deeptags, sentiment, engEntityRelationships, engStorylineId, engIptcTopics
      // translation to english will eventually contain word alignment info and timestamps;
      // currently just string
      description: 'english mainText',
      type: 'string',
    },
    engTeaser: {
      // translation to english will eventually contain word alignment info and timestamps;
      // currently just string
      description: 'english teaser',
      type: 'string',
    },
    engKeywords: {
      // keyword by keyword translations
      description: 'english keyword list',
      type: 'array',
      items: {
        type: 'string',
      },
    },
    engTranscript: {
      // -> engMainText
      description: 'english tarnslation of the contentTranscribedPunctuatedMainText',
      type: 'string',
    },


    // AMR results
    engTeaserAMR: { },
    engMainTextAMR: { },
    engTranscriptAMR: { },

    // Relationships results
    engTeaserRelationships: { },
    engMainTextRelationships: { },
    engTranscriptRelationships: { },


    //
    // eng added value
    engTeaserEntities: {
      // should contain info about entity positions in text
      description: 'list of entities in engMainText; should contain positions in text',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engMainTextEntities: {
      // should contain info about entity positions in text
      description: 'list of entities in engMainText; should contain positions in text',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engTranscriptEntities: {
      // should contain info about entity positions in text
      description: 'list of entities in engMainText; should contain positions in text',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    contentMainTextEntities: {
      description: 'list of entities in sourceItemMainText; should contain positions in text',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    contentTeaserEntities: {
      description: 'list of entities in sourceItemTeaser; should contain positions in text',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    contentTranscriptEntities: {
      description: 'list of entities in contentTranscribedPunctuatedMainText; should contain positions in text',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engSentiment: {
      description: 'sentiment; most likely string',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engEntityRelationships: {
      // should contain info about relationship places in text
      description: 'detected relationships between entities in text; should contain positions',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engStorylineId: {
      description: 'just reference to storyline from storylines table',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engIptcTopics: {
      description: 'list of ITPC Topics',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    engDetectedTopics: {
      description: 'the thing that comes out of the deeptagger nlp module',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    contentDetectedTopics: {
      description: 'counterpart of engDetectedTopics but on original content',
      // type: 'null', // null for now, so that we remember to write scheme when known
    },
    cacheFieldsInStorylineDone: {
      description: 'the fields have been cached in the storyline',
    },

    highlightItems: {
      description: 'few sentences that summarize all the news items from the current storyline',
    },


    entitiesCache: {
      description: 'cache of named entities found in the newsItem. should be calculated from engTeaserEntities, engMainTextEntities and engTranscriptEntities',
      type: 'array',
      items: {
        type: 'string',
      },
    },

    doneTimestamp: {
      description: 'timestamp when all the applicable NLP steps have finished',
      // currently manually written query in newsItem_done_timestamp step
      // but need to think how to do it automatically, because all the info is encoded in
      // in each steps dependencies
      type: 'number',
    },

    timeAdded: {
      description: 'in general timeAdded is calculated authomaticaly; but sometimes you want to set it directly, e.g. when merging content',
      type: 'string',
      format: 'date-time',
    },
  },
};

const resetFieldErrorsSchema = {
  title: 'Request body schema for field reset',
  type: 'object',
  required: [
    'fieldName',
  ],
  additionalProperties: false,
  properties: {
    fieldName: {
      description: 'the name of the field whose errors to reset',
      type: 'string',
      enum: _.keys(newsItemSchema.properties),
    },
  },
};


const newsItemChangableDataFields = _.keys(newsItemSchema.properties);
const newsItemPatchSchema = createPatchDescriptionSchema(newsItemChangableDataFields,
                                                         newsItemSchema);

const validateNewNewsItem = ajv.compile(newsItemSchema);
const validatePatchDescription = ajv.compile(newsItemPatchSchema);
const validateResetErrorsRequest = ajv.compile(resetFieldErrorsSchema);


const fieldsToCleanup = ['sourceItemTitle', 'sourceItemMainText', 'sourceItemTeaser'];

function stringCleanup(string) {
  // remove non braking chars
  // remove special chars

  return string
    // remove non braking space
    .replace(/\u00A0/g, ' ')
    .replace(new RegExp('&nbsp;', 'g'), ' ')

    // cleanup all spaces with a single space
    .replace(/\s+/g, ' ')

    // cleanup &amp;
    .replace(new RegExp('&amp;', 'g'), '&');
}

async function updatePrevNextLinks(table, prevItemIdAtOrigin, currentItemDBId) {
  try {
    const prevItems = await table
      .getAll(prevItemIdAtOrigin, { index: 'sourceItemIdAtOrigin' })
      .pluck('id')
      .limit(1)
      .run();

    if (!_.isEmpty(prevItems)) {
      const prevItemId = prevItems[0].id;
      table.get(currentItemDBId).update({ prevId: prevItemId }, { durability: 'soft' }).run();
      table.get(prevItemId).update({ nextId: currentItemDBId }, { durability: 'soft' }).run();
    }
  } catch (err) {
    console.log('[ERR] at prev/next link creation', err);
  }
}

export default (r, topLevelPath) => {
  const router = new Router();
  const table = r.table('newsItems');

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
    table
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
          message: 'Failed to get NewsItems',
          description: err,
        });
        next();
      });
  });

  router.get('/ids', async (request, response, next) => {
    // calculate start time
    let start;
    if (request.query.startEpochTimeSecs) {
      start = r.epochTime(r.expr(request.query.startEpochTimeSecs).coerceTo('number'));
    } else if (table.count() == 0) {
      start = r.now().toEpochTime();
    } else {
      start = table.min({ index: 'timeAdded' })('timeAdded');
    }

    // calculate end time
    let end;
    if (request.query.endEpochTimeSecs) {
      end = r.epochTime(r.expr(request.query.endEpochTimeSecs).coerceTo('number'));
    } else {
      end = r.now();
    }

    const maxResultCount = request.query.maxResultCount
                            ? parseInt(request.query.maxResultCount, 10)
                            : 100;

    const resultOffset = request.query.resultOffset
                            ? parseInt(request.query.resultOffset, 10)
                            : 0;

    const query = {
      startEpochTimeSecs: start.toEpochTime().round(),
      endEpochTimeSecs: end.toEpochTime().round(),
      maxResultCount,
      resultOffset,
    };

    const newsItemsWithinRangeQuery = table
      .between(start, end, { index: 'timeAdded' })
      .orderBy({ index: 'timeAdded' });

    const replay = {
      query,
      result: {
        totalNewsItemsWithinRange: newsItemsWithinRangeQuery.count(),
        newsItemIds: newsItemsWithinRangeQuery
          .slice(resultOffset, resultOffset + maxResultCount, { leftBound: 'closed', rightBound: 'closed' })
          .map(newsItem => newsItem('id'))
          .coerceTo('array'),
      },
    };

    r.expr(replay)
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
          message: 'Failed to get NewsItems',
          description: err,
        });
        next();
      });
  });

  router.get('/done-ids', async (request, response, next) => {
    // calculate start time
    let start;
    if (request.query.startEpochTimeSecs) {
      start = r.expr(request.query.startEpochTimeSecs).coerceTo('number');
    } else if (table.count() == 0) {
      start = r.now().toEpochTime();
    } else {
      start = table.min({ index: 'doneTimestamp' })('doneTimestamp');
    }

    // calculate end time
    let end;
    if (request.query.endEpochTimeSecs) {
      end = r.expr(request.query.endEpochTimeSecs).coerceTo('number');
    } else {
      end = r.now().toEpochTime();
    }

    const maxResultCount = request.query.maxResultCount
                            ? parseInt(request.query.maxResultCount, 10)
                            : 100;

    const resultOffset = request.query.resultOffset
                            ? parseInt(request.query.resultOffset, 10)
                            : 0;

    const query = {
      startEpochTimeSecs: start,
      endEpochTimeSecs: end,
      maxResultCount,
      resultOffset,
    };

    const newsItemsWithinRangeQuery = table
      .between(start, end, { index: 'doneTimestamp', leftBound: 'closed', rightBound: 'closed' })
      .orderBy({ index: 'doneTimestamp' });

    const replay = {
      query,
      result: {
        totalNewsItemsWithinRange: newsItemsWithinRangeQuery.count(),
        newsItemIds: newsItemsWithinRangeQuery
          .slice(resultOffset, resultOffset + maxResultCount, { leftBound: 'closed', rightBound: 'closed' })
          .map(newsItem => newsItem('id'))
          .coerceTo('array'),
      },
    };

    r.expr(replay)
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
          message: 'Failed to get NewsItems',
          description: err,
        });
        next();
      });
  });


  router.get('/:id', (request, response, next) => {
    const newsItemId = request.params.id;
    table
      .get(newsItemId)
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
          message: `Failed to get NewsItem ${newsItemId}`,
          description: err,
        });
        next();
      });
  });


  router.post('/', (request, response, next) => {
    const rawRequestContent = request.body;

    // FIXME workaround for current hls Chunker
    // chunker should use the correct keys
    if (rawRequestContent.chunk_relative_url) {
      rawRequestContent.sourceItemIdAtOrigin = rawRequestContent.chunk_relative_url;
      rawRequestContent.prevSourceItemIdAtOrigin = rawRequestContent.prev_chunk_relative_url;
    }

    // restructure request to get the allowed field names on top level
    // and everything else put into metadata
    const topLevelProperties = _.keys(newsItemSchema.properties);
    const requestProperties = _.keys(rawRequestContent);
    const extraProperties = _.difference(requestProperties, topLevelProperties);

    const requestedNewsItemContent = {
      ..._.pick(rawRequestContent, topLevelProperties),
      customMetadata: {
        ..._.pick(rawRequestContent, extraProperties),
        ...rawRequestContent.customMetadata,
      },
    };

    const dbErrorReport = (err) => {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to create NewsItem',
        description: err,
      });
      next();
    };

    // cleanup submisison text content
    _.each(fieldsToCleanup, (fieldName) => {
      if (_.has(requestedNewsItemContent, fieldName)) {
        requestedNewsItemContent[fieldName] = stringCleanup(requestedNewsItemContent[fieldName]);
      }
    });

    if (!validateNewNewsItem(requestedNewsItemContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateNewNewsItem.errors),
      });
    } else {
      // create the new document
      // transform all fields to extended structure

      // FIXME: we have lang detection for text
      //        need to use guess only for the case when we only have a videoURL or audioURL
      //        without any text content
      if ((requestedNewsItemContent.sourceItemVideoURL ||
           requestedNewsItemContent.sourceItemAudioURL)
          &&
          // don't use sourceItemTitle for lang detection, because livestreams have autogenerated
          !(requestedNewsItemContent.sourceItemTeaser ||
            requestedNewsItemContent.sourceItemMainText)) {
        requestedNewsItemContent.contentDetectedLangCode =
          requestedNewsItemContent.sourceItemLangeCodeGuess;
      }

      const sourceItemIdAtOrigin = (rawRequestContent.sourceItemIdAtOrigin ||
        rawRequestContent.sourceItemVideoURL || rawRequestContent.sourceItemAudioURL);

      // because we reference by id
      // create if missing
      const feedURL = requestedNewsItemContent.feedURL;
      r.table('feeds')
        .getAll(feedURL, { index: 'url' })
        .coerceTo('array')
        .do(feeds => (
          r.branch(
            feeds.count().ge(1),
            feeds.nth(0)('id'),
            r.table('feeds')
              .insert({
                name: feedURL,
                url: feedURL,
                feedType: 'unknown',
              }, { durability: 'soft', returnChanges: true })
              .do(result => result('generated_keys').default([])(0).default(null)),
          )
        ))
        .run()
        .then((feedId) => {
          const newNewsItem = {
            source: requestedNewsItemContent.source,
            timeAdded: requestedNewsItemContent.timeAdded
                        ? r.ISO8601(requestedNewsItemContent.timeAdded)
                        : r.now(),
            feedId,
            summaPlatformProcessingMetadata: {
              timeAdded: makeDataFieldValue(r, 'internal', 'final', r.now()),
              feedId: makeDataFieldValue(r, 'internal', 'final', r.now()),
            },
          };
          _.without(_.keys(requestedNewsItemContent), 'timeAdded').forEach((field) => {
            newNewsItem[field] = requestedNewsItemContent[field];
            newNewsItem.summaPlatformProcessingMetadata[field] = makeDataFieldValue(r,
              requestedNewsItemContent.source, 'final', requestedNewsItemContent[field]);
          });

          // check if item with such id already exists
          const existingItemWithSameRemoteId = table
            .getAll(sourceItemIdAtOrigin, { index: 'sourceItemIdAtOrigin' });
          r.branch(
            existingItemWithSameRemoteId.count().eq(0),
            // insert if no duplicates
            table.insert(newNewsItem, { durability: 'soft', returnChanges: 'always' }),
            // report duplicates if present
            // FIXME: need to update the feed list
            //        because its ok for item to come from multiple feeds
            { existingItemIds: existingItemWithSameRemoteId.pluck('id').coerceTo('array') },
          )
          .run()
          .then((result) => {
            if (!_.has(result, 'existingItemIds')) {
              let errorEncountered;
              try {
                const updates = _.chain(['inserted', 'unchanged', 'replaced'])
                  .map(key => result[key])
                  .reduce((a, b) => a + b, 0)
                  .value();
                console.assert(updates >= 1, `must be some change, but got ${updates} ${JSON.stringify(result)}`);
              } catch (err) {
                errorEncountered = true;
                dbErrorReport(err);
              }

              if (!errorEncountered) {
                response.status(201) // 201 – created
                  .location(`${topLevelPath}/${result.generated_keys[0]}`)
                  .json(result.changes[0].new_val);

                // add link to previous and next
                if (requestedNewsItemContent.prevSourceItemIdAtOrigin) {
                  const prevItemIdAtOrigin = requestedNewsItemContent.prevSourceItemIdAtOrigin;
                  const currentItemDBId = result.generated_keys[0];
                  updatePrevNextLinks(table, prevItemIdAtOrigin, currentItemDBId);
                }
              }
            } else {
              // console.log('item already exists', result);
              response.status(208) // 208 Already Reported
                .json(result);
            }
          })
          .error(dbErrorReport);
        })
        .error(dbErrorReport);
    }
  });

  router.post('/resetErrors', (request, response, next) => {
    const requestContent = request.body;

    if (!validateResetErrorsRequest(requestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateResetErrorsRequest.errors),
      });
    } else {
      const fieldName = requestContent.fieldName;
      const tableName = 'newsItems';
      const filterFn = query => query.filter({
        summaPlatformProcessingMetadata: {
          [fieldName]: {
            status: 'error',
          },
        },
      });
      const actionDescriptionStr = 'reset field errors';
      clearDbFields(r, tableName, fieldName, filterFn, actionDescriptionStr, response, next);
    }
  });
  router.post('/clearFieldValues', (request, response, next) => {
    const requestContent = request.body;

    if (!validateResetErrorsRequest(requestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateResetErrorsRequest.errors),
      });
    } else {
      const fieldName = requestContent.fieldName;
      const tableName = 'newsItems';
      const filterFn = query => query;
      const actionDescriptionStr = 'reset field errors';
      clearDbFields(r, tableName, fieldName, filterFn, actionDescriptionStr, response, next);
    }
  });

  router.patch('/:id', (request, response, next) => {
    const tableName = 'newsItems';
    handlePatchRequest(validatePatchDescription, r, topLevelPath,
                       tableName, request, response, next);
  });


  return router;
};
