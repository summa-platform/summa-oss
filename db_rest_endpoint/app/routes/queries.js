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

const namedEntityFilterTypes = [
  { label: 'Any', internalval: 'OR' },
  { label: 'All', internalval: 'AND' },
];


const createItemSchema = {
  title: 'query schema',
  type: 'object',
  required: [
    'name',
    'user',
    'feedGroups',
    'namedEntities',
    'namedEntityFilterType',
  ],
  additionalProperties: false,
  properties: {
    name: {
      // for gui and statistics
      description: 'name of the query',
      type: 'string',
    },
    user: {
      description: 'id of the user',
      type: 'string',
    },
    feedGroups: {
      description: 'list with feedGroup ids',
      type: 'array',
      items: {
        description: 'feedGroup id',
        type: 'string',
      },
    },
    namedEntities: {
      description: 'list with namedEntity baseForm strings',
      type: 'array',
      items: {
        description: 'namedEntity baseForm string',
        type: 'string',
      },
    },
    namedEntityFilterType: {
      description: 'filter named entities with OR or AND semantics',
      type: 'string',
      enum: _.map(namedEntityFilterTypes, feedType => feedType.internalval),
    },
  },
};

const freeformQuerySchema = {
  title: 'freeform query schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    startEpochTimeSecs: {
      description: 'query start epoch time; defaults to now-24h',
      type: 'number',
    },
    endEpochTimeSecs: {
      description: 'query end epoch time; defaults to now',
      type: 'number',
    },
    feedGroupIds: {
      description: 'list with feedGroup ids; defaults to all existng feeds',
      type: 'array',
      items: {
        description: 'feedGroup id',
        type: 'string',
      },
    },
    namedEntities: {
      description: 'list with namedEntity baseForm strings; defaults to emtpy list',
      type: 'array',
      items: {
        description: 'namedEntity baseForm string',
        type: 'string',
      },
    },
    namedEntityFilterType: {
      description: 'filter named entities with OR or AND semantics; defaults to OR',
      type: 'string',
      enum: _.map(namedEntityFilterTypes, feedType => feedType.internalval),
    },
    topResultOffset: {
      description: 'how many items to skip when returning a query; defaults to 0',
      type: 'number',
    },
    topResultCount: {
      description: 'how many results to return; defaults to 10',
      type: 'number',
    },
    doReturnTotalTopResultCount: {
      description: 'if true, return total result count',
      type: 'boolean',
    },
  },
};


const updateItemSchema = { ...createItemSchema, required: undefined };

const validateCreateItem = ajv.compile(createItemSchema);
const validateUpdateItem = ajv.compile(updateItemSchema);

const validateFreeformQuery = ajv.compile(freeformQuerySchema);


export default (r, topLevelPath) => {
  const table = r.table('queries');
  const router = new Router();

  const allQuery = r.expr({
    id: 'all',
    name: 'All',
    feedGroups: [],
    namedEntities: [],
    namedEntityFilterType: 'OR',
  });

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

  const getExtendedFeedGroups = query => ({
    feedGroups: r.db(config.db.dbName)
        .table('feedGroups')
        .filter(feedGroup => query('feedGroups').contains(feedGroup('id')))
        .pluck('id', 'name')
        .coerceTo('array'),
  });

  router.get('/namedEntityFilterTypes', (request, response) => {
    response.status(200) // 200 - ok
      .json(namedEntityFilterTypes);
  });

  router.get('/', (request, response, next) => {
    table
      .merge(getExtendedFeedGroups)
      .run()
      .then((result) => {
        response.status(200) // 200 – ok
          .json(result);
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get Queries',
          description: err,
        });
        next();
      });
  });


  // common entities that are not interesting
  const blacklistedEntities = r.expr([
    null, // empty value
    '', // empty string

    // days of the week
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',

    // months
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',

    // years
    '2013', '2014', '2015', '2016', '2017', '2018',

    // media organizations
    'AFP', 'Reuters', 'DW', 'BBC', 'Twitter', 'Facebook',
  ]);

  const newsItemsWithinPeriod = (start, end) => (
    r.table('newsItems')
      .between(start, end, { index: 'timeAdded' })
  );

  const newsItemsWithinPeriodFromStoryline = (start, end, storylineId) => (
    r.table('newsItems')
      .between([storylineId, start], [storylineId, end], { index: 'storylineId-timeAdded' })
  );

  const newsItemsWithinPeriodWithEntity = (start, end, entity) => (
    r.table('newsItems')
      .between([entity, start], [entity, end], { index: 'entity-timeAdded' })
  );

  const filterNewsItemsBy = (rSequence,
                             { namedEntities: entities,
                               namedEntityFilterType: entitiesFilterType, feedGroupIds }) => {
    let filterRSequence = rSequence;

    // add entity filter
    if (entities.length > 0) {
      if (entitiesFilterType === 'AND') {
        filterRSequence = filterRSequence.filter(row => row('entitiesCache').default([]).contains(...entities));
      } else if (entitiesFilterType === 'OR') {
        filterRSequence = filterRSequence
          .filter(row => row('entitiesCache')
            .default([])
            .contains(entity => r.expr(entities).contains(entity)));
      } else {
        throw new Error(`unknown entity filter type: '${entitiesFilterType}'`);
      }
    }

    // add feed filter
    // TODO check maybe faster with create feeds object and checking with hasFields
    if (feedGroupIds.length > 0) {
      const feedIds = r.table('feedGroups')
        .getAll(...feedGroupIds)
        .concatMap(feedGroup => feedGroup('feeds').default([]));

      filterRSequence = filterRSequence.filter(row => feedIds.contains(row('feedId')));
    }

    return filterRSequence;
  };

  const hourlyDistribution = (newsItems, end, timeFieldName) => (
    newsItems
      .group(item => getHourOffsetBin(r, end, item(timeFieldName)))
      .count()
      .ungroup()
      .map(group => [group('group'), group('reduction')])
      .coerceTo('object')
  );

  const entityHourlyDistribution = (start, end, entity, filterConditions) => {
    const newsItems = filterNewsItemsBy(
                        newsItemsWithinPeriodWithEntity(start, end, entity),
                        filterConditions,
                      );
    return hourlyDistribution(newsItems, end, 'timeAdded');
  };

  function filterConditionsFromOptionals(optFilterConditions,
                                         optStartEpochTimeSecs, optEndEpochTimeSecs,
                                         optTopResultOffset, optTopResultCount,
                                         optDoReturnTotalTopResultCount) {
    const rStartTime = (optStartEpochTimeSecs
                        ? r.epochTime(optStartEpochTimeSecs)
                        : r.now().sub(24 * hourInSeconds));
    const rEndTime = (optEndEpochTimeSecs
                      ? r.epochTime(optEndEpochTimeSecs)
                      : r.now());
    const topResultOffset = optTopResultOffset || 0;
    const topResultCount = optTopResultCount || 10;
    const filterConditions = {
      namedEntities: optFilterConditions.namedEntities || [],
      namedEntityFilterType: optFilterConditions.namedEntityFilterType || 'OR',
      feedGroupIds: optFilterConditions.feedGroupIds || [],
    };
    const doReturnTotalTopResultCount = optDoReturnTotalTopResultCount || false;

    return {
      rStartTime,
      rEndTime,
      topResultOffset,
      topResultCount,
      filterConditions,
      doReturnTotalTopResultCount,
    };
  }

  function newsItemStatistics(optFilterConditions,
                              optStartEpochTimeSecs, optEndEpochTimeSecs,
                              optTopResultOffset, optTopResultCount,
                              optDoReturnTotalTopResultCount) {
    const query = filterConditionsFromOptionals(optFilterConditions,
                                                optStartEpochTimeSecs, optEndEpochTimeSecs,
                                                optTopResultOffset, optTopResultCount,
                                                optDoReturnTotalTopResultCount);
    const {
      rStartTime,
      rEndTime,
      topResultOffset,
      topResultCount,
      filterConditions,
      doReturnTotalTopResultCount,
    } = query;

    const newsItems = filterNewsItemsBy(
      newsItemsWithinPeriod(rStartTime, rEndTime), filterConditions,
    );

    // * incomming newsitem count by timeAdded
    // * newsItem count by feedURL and timeAdded
    // * newsItem count by isDoneTimestamp

    return r.expr({
      query,
      result: {
        overview: {
          incomming: hourlyDistribution(newsItems, rEndTime, 'timeAdded'),
          ofThoseDone: hourlyDistribution(newsItems.hasFields('doneTimestamp'), rEndTime, 'timeAdded'),
        },
        incommingByFeedsByTimeAdded: newsItems
          .group('feedURL')
          .ungroup()
          .orderBy(r.desc(g => g('reduction').count()))
          .map(g => [g('group'), hourlyDistribution(g('reduction'), rEndTime, 'timeAdded')]),
        epochTimeSecs: rEndTime.toEpochTime().round(),
      },
    });
  }

  function trendingEntities(optFilterConditions,
                            optStartEpochTimeSecs, optEndEpochTimeSecs,
                            optTopResultOffset, optTopResultCount,
                            optDoReturnTotalTopResultCount) {
    const query = filterConditionsFromOptionals(optFilterConditions,
                                                optStartEpochTimeSecs, optEndEpochTimeSecs,
                                                optTopResultOffset, optTopResultCount,
                                                optDoReturnTotalTopResultCount);
    const {
      rStartTime,
      rEndTime,
      topResultOffset,
      topResultCount,
      filterConditions,
      doReturnTotalTopResultCount,
    } = query;

    const newsItems = filterNewsItemsBy(
      newsItemsWithinPeriod(rStartTime, rEndTime), filterConditions,
    );

    const formatEntity = entity => ({
      id: r.table('namedEntities')
        .getAll(entity, { index: 'baseForm' })
        .nth(0)
        .default({})('id')
        .default(null),
      baseForm: entity,
      bins: entityHourlyDistribution(rStartTime, rEndTime, entity, filterConditions),
    });


    let topEntities = newsItems
      .pluck('id', 'timeAdded', 'entitiesCache', 'feedId', 'engStorylineId')
      .group('entitiesCache', { multi: true })
      .count()
      .ungroup()
      .orderBy(r.desc('reduction'))
      .filter(group => r.expr(blacklistedEntities).contains(group('group')).not())
      .map(group => group('group'));
    const resultCount = topEntities.count();
    if (_.isNumber(topResultOffset) && _.isNumber(topResultCount)) {
      topEntities = topEntities.slice(topResultOffset, topResultOffset + topResultCount);
    }
    if (topResultCount <= 0) {
      topEntities = r.expr([]);
    }

    return r.expr({
      query,
      result: {
        selectedEntities: r.expr(filterConditions.namedEntities)
          .map(formatEntity).coerceTo('array'),
        allItems: {
          newlyAdded: hourlyDistribution(newsItems, rEndTime, 'timeAdded'),
          ofThoseDone: hourlyDistribution(newsItems.hasFields('doneTimestamp'), rEndTime, 'timeAdded'),
        },
        topKEntities: topEntities.map(formatEntity).coerceTo('array'),
        epochTimeSecs: rEndTime.toEpochTime().round(),
        totalTopResultCount: doReturnTotalTopResultCount ? resultCount : undefined,
      },
    });
  }

  function filteredStories(optFilterConditions,
                           optStartEpochTimeSecs, optEndEpochTimeSecs,
                           optTopResultOffset, optTopResultCount,
                           optDoReturnTotalTopResultCount) {
    const query = filterConditionsFromOptionals(optFilterConditions,
                                                optStartEpochTimeSecs, optEndEpochTimeSecs,
                                                optTopResultOffset, optTopResultCount,
                                                optDoReturnTotalTopResultCount);
    const {
      rStartTime,
      rEndTime,
      topResultOffset,
      topResultCount,
      filterConditions,
      doReturnTotalTopResultCount,
    } = query;

    const newsItems = filterNewsItemsBy(newsItemsWithinPeriod(rStartTime, rEndTime),
                                        filterConditions);
    let storyIds = newsItems
      .group('engStorylineId')
      .count()
      .ungroup()
      .orderBy(r.desc('reduction'))
      .filter(group => group('group').eq(null).not()); // filter non existant story
    const resultCount = storyIds.count();
    if (_.isNumber(optTopResultOffset) && _.isNumber(optTopResultCount)) {
      storyIds = storyIds.slice(topResultOffset, topResultOffset + topResultCount);
    }
    storyIds = storyIds.map(group => group('group'));

    const stories = storyIds
      .map((storyId) => {
        const storyline = r.db(config.db.dbName)
          .table('storylines').get(storyId);

        const storyFilteredNewsItems = filterNewsItemsBy(
          newsItemsWithinPeriodFromStoryline(rStartTime, rEndTime, storyline('id')),
          filterConditions,
        );

        return {
          id: storyline('id'),
          title: r.branch(storyFilteredNewsItems.count().gt(0), storyFilteredNewsItems.hasFields('engTitle').nth(0).default({ engTitle: '<missing>' })('engTitle'), ''),
          latestItemTime: storyFilteredNewsItems
            .map(newsItem => newsItem('timeAdded'))
            .max(),
          itemCount: storyFilteredNewsItems.count(),
          mediaItemTypes: storyFilteredNewsItems
            .merge(item => ({ sourceItemType: r.branch(item('sourceItemType').eq('livefeed-logical-chunk'), 'Video', item('sourceItemType')) }))
            .group('sourceItemType')
            .count()
            .ungroup()
            .map(group => [group('group'), group('reduction')])
            .coerceTo('object'),
          mediaItemLangs: storyFilteredNewsItems
            .group('contentDetectedLangCode')
            .count()
            .ungroup()
            .map(group => [group('group'), group('reduction')])
            .coerceTo('object'),
        };
      })
      .orderBy(r.desc('itemCount'))
      .coerceTo('array');

    return r.expr({
      query,
      result: {
        ...filterConditions,
        stories,
        totalTopResultCount: doReturnTotalTopResultCount ? resultCount : undefined,
      },
    });
  }

  function getFormatedStoryWithNewsItems(storyId, optFilterConditions,
                                         optStartEpochTimeSecs, optEndEpochTimeSecs,
                                         optTopResultOffset, optTopResultCount,
                                         optDoReturnTotalTopResultCount) {
    const query = filterConditionsFromOptionals(optFilterConditions,
                                                optStartEpochTimeSecs, optEndEpochTimeSecs,
                                                optTopResultOffset, optTopResultCount,
                                                optDoReturnTotalTopResultCount);
    const {
      rStartTime,
      rEndTime,
      topResultOffset,
      topResultCount,
      filterConditions,
      doReturnTotalTopResultCount,
    } = query;

    let storyFilteredNewsItems = filterNewsItemsBy(
      newsItemsWithinPeriodFromStoryline(rStartTime, rEndTime, storyId),
      filterConditions,
    )
      .orderBy(r.desc('timeAdded'));
    const resultCount = storyFilteredNewsItems.count();
    if (_.isNumber(optTopResultOffset) && _.isNumber(optTopResultCount)) {
      storyFilteredNewsItems = storyFilteredNewsItems.slice(topResultOffset,
                                                            topResultOffset + topResultCount);
    }

    const story = r.db(config.db.dbName)
      .table('storylines').get(storyId);

    return r.expr({
      query,
      result: {
        id: story('id'),
        title: story('label').default(''),
        timeChanged: r.branch(
          storyFilteredNewsItems.count().gt(0),
          storyFilteredNewsItems.map(newsItem => newsItem('timeAdded')).nth(0),
          story('timeAdded'),
        ),
        summary: story('highlightItems')
          .default([])
          .fold('', (acc, highlightItem) => acc.add(highlightItem('highlight'), ' ')),
        mediaItems: getFormatedNewsItems(r, storyFilteredNewsItems),
        totalTopResultCount: doReturnTotalTopResultCount ? resultCount : undefined,
      },
    });
  }

  function getFormattedNewsItemsFromPeriodWithEntity(entity,
                                                     optFilterConditions,
                                                     optStartEpochTimeSecs, optEndEpochTimeSecs,
                                                     optTopResultOffset, optTopResultCount,
                                                     optDoReturnTotalTopResultCount) {
    const query = filterConditionsFromOptionals(optFilterConditions,
                                                optStartEpochTimeSecs, optEndEpochTimeSecs,
                                                optTopResultOffset, optTopResultCount,
                                                optDoReturnTotalTopResultCount);
    const {
      rStartTime,
      rEndTime,
      topResultOffset,
      topResultCount,
      filterConditions,
      doReturnTotalTopResultCount,
    } = query;

    let newsItems = filterNewsItemsBy(
      newsItemsWithinPeriodWithEntity(rStartTime, rEndTime, entity),
      filterConditions,
    )
      .orderBy(r.desc('timeAdded'));
    const resultCount = newsItems.count();
    if (_.isNumber(optTopResultOffset) && _.isNumber(optTopResultCount)) {
      newsItems = newsItems.slice(topResultOffset, topResultOffset + topResultCount);
    }

    return r.expr({
      query,
      result: {
        mediaItems: getFormatedNewsItems(r, newsItems),
        totalTopResultCount: doReturnTotalTopResultCount ? resultCount : undefined,
      },
    });
  }

  router.post('/free-form-query/statistics', async (request, response, next) => {
    const rawRequestContent = request.body;
    try {
      if (!validateFreeformQuery(rawRequestContent)) {
        reportError(response, {
          httpStatusCode: 422, // 422 - Unprocessable Entity
          message: 'Validation Failed',
          errors: formatValidationErrors(validateFreeformQuery.errors),
        });
      } else {
        const filterConditions = {
          namedEntities: rawRequestContent.namedEntities,
          namedEntityFilterType: rawRequestContent.namedEntityFilterType,
          feedGroupIds: rawRequestContent.feedGroupIds,
        };
        const start = (rawRequestContent.startEpochTimeSecs
                       || r.now().sub(24 * hourInSeconds).toEpochTime());
        const end = rawRequestContent.endEpochTimeSecs;
        const topResultOffset = rawRequestContent.topResultOffset;
        const topResultCount = rawRequestContent.topResultCount;
        const doReturnTotalTopResultCount = rawRequestContent.doReturnTotalTopResultCount;

        const query = newsItemStatistics(filterConditions,
                                         start, end,
                                         topResultOffset, topResultCount,
                                         doReturnTotalTopResultCount);

        const result = await query.run();

        response.status(200) // 200 – ok
          .json(result);
        next();
      }
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to execute free form query',
        description: err,
      });
      next();
    }
  });

  router.post('/free-form-query/trending', async (request, response, next) => {
    const rawRequestContent = request.body;
    try {
      if (!validateFreeformQuery(rawRequestContent)) {
        reportError(response, {
          httpStatusCode: 422, // 422 - Unprocessable Entity
          message: 'Validation Failed',
          errors: formatValidationErrors(validateFreeformQuery.errors),
        });
      } else {
        const filterConditions = {
          namedEntities: rawRequestContent.namedEntities,
          namedEntityFilterType: rawRequestContent.namedEntityFilterType,
          feedGroupIds: rawRequestContent.feedGroupIds,
        };
        const start = (rawRequestContent.startEpochTimeSecs
                       || r.now().sub(24 * hourInSeconds).toEpochTime());
        const end = rawRequestContent.endEpochTimeSecs;
        const topResultOffset = rawRequestContent.topResultOffset;
        const topResultCount = rawRequestContent.topResultCount;
        const doReturnTotalTopResultCount = rawRequestContent.doReturnTotalTopResultCount;

        const query = trendingEntities(filterConditions,
                                       start, end,
                                       topResultOffset, topResultCount,
                                       doReturnTotalTopResultCount);

        const result = await query.run();

        response.status(200) // 200 – ok
          .json(result);
        next();
      }
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to execute free form query',
        description: err,
      });
      next();
    }
  });

  router.post('/free-form-query/stories', async (request, response, next) => {
    const rawRequestContent = request.body;

    try {
      if (!validateFreeformQuery(rawRequestContent)) {
        reportError(response, {
          httpStatusCode: 422, // 422 - Unprocessable Entity
          message: 'Validation Failed',
          errors: formatValidationErrors(validateFreeformQuery.errors),
        });
      } else {
        const filterConditions = {
          namedEntities: rawRequestContent.namedEntities,
          namedEntityFilterType: rawRequestContent.namedEntityFilterType,
          feedGroupIds: rawRequestContent.feedGroupIds,
        };
        const start = (rawRequestContent.startEpochTimeSecs
                       || r.now().sub(24 * hourInSeconds).toEpochTime());
        const end = rawRequestContent.endEpochTimeSecs;
        const topResultOffset = rawRequestContent.topResultOffset;
        const topResultCount = rawRequestContent.topResultCount;
        const doReturnTotalTopResultCount = rawRequestContent.doReturnTotalTopResultCount;

        const query = filteredStories(filterConditions,
                                      start, end,
                                      topResultOffset, topResultCount,
                                      doReturnTotalTopResultCount);

        const result = await query.run();

        response.status(200) // 200 – ok
          .json(result);
        next();
      }
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to execute free form query',
        description: err,
      });
      next();
    }
  });

  router.post('/free-form-query/stories/:storyId', async (request, response, next) => {
    const rawRequestContent = request.body;
    const storyId = request.params.storyId;

    try {
      if (!validateFreeformQuery(rawRequestContent)) {
        reportError(response, {
          httpStatusCode: 422, // 422 - Unprocessable Entity
          message: 'Validation Failed',
          errors: formatValidationErrors(validateFreeformQuery.errors),
        });
      } else {
        const filterConditions = {
          namedEntities: rawRequestContent.namedEntities,
          namedEntityFilterType: rawRequestContent.namedEntityFilterType,
          feedGroupIds: rawRequestContent.feedGroupIds,
        };
        const start = rawRequestContent.startEpochTimeSecs;
        const end = rawRequestContent.endEpochTimeSecs;
        const topResultOffset = rawRequestContent.topResultOffset;
        const topResultCount = rawRequestContent.topResultCount;
        const doReturnTotalTopResultCount = rawRequestContent.doReturnTotalTopResultCount;

        const query = getFormatedStoryWithNewsItems(storyId, filterConditions,
                                                    start, end,
                                                    topResultOffset, topResultCount,
                                                    doReturnTotalTopResultCount);

        const result = await query.run();

        response.status(200) // 200 – ok
          .json(result);
        next();
      }
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to execute free form query',
        description: err,
      });
      next();
    }
  });


  function getMediaItemSelectionParams(request) {
    const epochTimeSecs = request.query.epochTimeSecs;
    const end = r.epochTime(r.expr(epochTimeSecs).coerceTo('number')) || r.now();
    const pastHourString = request.query.pastHourString || '-0';
    const namedEntity = request.query.namedEntity || '';

    return {
      end: end.sub((-(pastHourString || '-24')) * hourInSeconds).toEpochTime(),
      start: end.sub((-(pastHourString || '-24') + 1) * hourInSeconds).toEpochTime(),
      namedEntity,
    };
  }

  // /free-form-query/trending/mediaItemSelection?namedEntity=<entityX>
  router.post('/free-form-query/mediaItemSelection', async (request, response, next) => {
    const rawRequestContent = request.body;
    const { namedEntity } = getMediaItemSelectionParams(request);

    try {
      if (!validateFreeformQuery(rawRequestContent)) {
        reportError(response, {
          httpStatusCode: 422, // 422 - Unprocessable Entity
          message: 'Validation Failed',
          errors: formatValidationErrors(validateFreeformQuery.errors),
        });
      } else {
        const filterConditions = {
          namedEntities: rawRequestContent.namedEntities,
          namedEntityFilterType: rawRequestContent.namedEntityFilterType,
          feedGroupIds: rawRequestContent.feedGroupIds,
        };
        const start = rawRequestContent.startEpochTimeSecs;
        const end = rawRequestContent.endEpochTimeSecs;
        const topResultOffset = rawRequestContent.topResultOffset;
        const topResultCount = rawRequestContent.topResultCount;
        const doReturnTotalTopResultCount = rawRequestContent.doReturnTotalTopResultCount;

        const query = getFormattedNewsItemsFromPeriodWithEntity(namedEntity, filterConditions,
                                                                start, end,
                                                                topResultOffset, topResultCount,
                                                                doReturnTotalTopResultCount);

        const result = await query.run();

        response.status(200) // 200 – ok
          .json(result);
        next();
      }
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to execute free form query',
        description: err,
      });
      next();
    }
  });

  async function retrieveSavedQuery(queryId) {
    let query;
    if (queryId === 'all') {
      query = allQuery;
    } else {
      query = await table
        .get(queryId).run();
      query.feedGroupIds = query.feedGroups;
    }
    return query;
  }

  router.get('/:queryId/trending', async (request, response, next) => {
    const queryId = request.params.queryId;

    // get a query
    let query;
    try {
      query = await retrieveSavedQuery(queryId);
    } catch (getQueryError) {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to get Query ${queryId}`,
        description: getQueryError,
      });
      next();
    }

    // get query trending
    if (query) {
      try {
        const start = r.now().sub(24 * hourInSeconds).toEpochTime();
        const trending = await trendingEntities(query, start).run();

        response.status(200) // 200 - ok
          .json({
            id: query.id,
            name: query.name,
            ...trending.result,
          });
        next();
      } catch (getTrendingError) {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Query ${queryId} results`,
          description: getTrendingError,
        });
      }
    }
  });

  router.get('/:queryId/stories', async (request, response, next) => {
    const queryId = request.params.queryId;

    // get a query
    let query;
    try {
      query = await retrieveSavedQuery(queryId);
    } catch (getQueryError) {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to get Query ${queryId}`,
        description: getQueryError,
      });
      next();
    }

    // get query stories
    if (query) {
      try {
        const start = r.now().sub(24 * hourInSeconds).toEpochTime();
        const stories = await filteredStories(query, start).run();

        response.status(200) // 200 - ok
          .json({
            id: query.id,
            name: query.name,
            ...stories.result,
          });
        next();
      } catch (getTrendingError) {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Query ${queryId} results`,
          description: getTrendingError,
        });
      }
    }
  });

  router.get('/:queryId/stories/:storyId', async (request, response, next) => {
    const queryId = request.params.queryId;
    const storyId = request.params.storyId;

    // get a query
    let query;
    try {
      query = await retrieveSavedQuery(queryId);
    } catch (getQueryError) {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to get Query ${queryId}`,
        description: getQueryError,
      });
      next();
    }

    // get query stories
    if (query) {
      try {
        const start = r.now().sub(24 * hourInSeconds).toEpochTime();
        const story = await getFormatedStoryWithNewsItems(storyId, query, start).run();

        response.status(200) // 200 - ok
          .json({
            id: query.id,
            name: query.name,
            ...story.result,
          });
        next();
      } catch (getTrendingError) {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Query ${queryId} results`,
          description: getTrendingError,
        });
      }
    }
  });

  // /trending/mediaItemSelection?namedEntity=<entityX>&epochTimeSecs=<intSecs>&pastHour=<-hString>
  router.get('/:queryId/trending/mediaItemSelection', async (request, response, next) => {
    const queryId = request.params.queryId;
    const params = getMediaItemSelectionParams(request, response, next);

    // get a query
    let query;
    try {
      query = await retrieveSavedQuery(queryId);
    } catch (getQueryError) {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to get Query ${queryId}`,
        description: getQueryError,
      });
      next();
    }

    // get query stories
    if (query) {
      const {
        start,
        end,
        namedEntity } = params;

      try {
        const rQuery = getFormattedNewsItemsFromPeriodWithEntity(namedEntity, query,
                                                                 start, end);
        const mediaItemSelection = await rQuery.run();

        response.status(200) // 200 - ok
          .json({
            id: query.id,
            name: query.name,
            ...mediaItemSelection.result,
          });
        next();
      } catch (getTrendingError) {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Query ${queryId} results`,
          description: getTrendingError,
        });
      }
    }
  });


  router.get('/:queryId', (request, response, next) => {
    const queryId = request.params.queryId;

    let rQuery;
    if (queryId === 'all') {
      rQuery = allQuery;
    } else {
      rQuery = table
        .get(queryId);
    }

    rQuery
      .do(item => r.branch(item, item.merge(getExtendedFeedGroups), item))
      .run()
      .then((result) => {
        if (result) {
          response.status(200) // 200 – ok
            .json(result);
        } else {
          response.status(404) // 404 - not found
            .json(result);
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get Query ${queryId}`,
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
        .insert({
          namedEntityFilterType: 'OR',
          ...rawRequestContent,
        }, { returnChanges: true })
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
            message: 'Failed to create Query',
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
        message: `Failed to update Query ${id}`,
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
        message: `Failed to delete Query ${id}`,
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
            message: `no query with id ${id}`,
            errors: `no query with id ${id}`,
          });
        } else {
          table.get(id).delete()
          .run()
          .then((deletionResult) => {
            console.log('Query deleted', deletionResult);
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
