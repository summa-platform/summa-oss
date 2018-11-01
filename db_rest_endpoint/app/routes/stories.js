import { Router } from 'express';
import { reportError } from '../common/errorReporting.js';
import { getMediaItemType } from '../common/utils.js';
import config from '../config.js';

export default (r, topLevelPath) => { // eslint-disable-line
  const table = r.table('storylines');
  const router = new Router();

  router.get('/', (request, response, next) => {
    table
      // calculate fields
      .merge((story) => {
        const newsItems = r.db(config.db.dbName)
          .table('newsItems')
          .between([story('id'), r.minval], [story('id'), r.maxval], { index: 'storylineId-timeAdded' });
        return {
          itemCount: newsItems.count(),
          latestItemTime: r.branch(newsItems.isEmpty(),
                                   null,
                                   newsItems.map(newsItem => newsItem('timeAdded')).max()),
          title: r.branch(newsItems.count().gt(0), newsItems.nth(0)('engTitle'), ''),
        };
      })
      .filter(story => story('itemCount').gt(0))
      // select relevant fields
      .pluck('id', 'title', 'latestItemTime', 'itemCount')
      .orderBy(r.desc('itemCount'))
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
        message: 'Failed to get Stories',
        description: err,
      });
      next();
    });
  });

  router.get('/:id', (request, response, next) => {
    const id = request.params.id;
    const getStoryFields = story => ({
      id: story('id'),
      title: story('label').default(''),
      timeChanged: r.branch(
        story('newsItems').default({}).values().count()
          .gt(0),
        story('newsItems').default({}).values().map(newsItem => newsItem('timeAdded'))
          .max(),
        story('timeAdded'),
      ),
      summary: story('highlightItems')
        .default([])
        .map(highlightItem => highlightItem('highlight').default('')),
      mediaItems: story('newsItems')
        .default({}).values()
        .map((newsItem) => {
          const fullNewsItem = r.table('newsItems')
            .get(newsItem('id'));

          return {
            id: newsItem('id'),
            source: r.table('feeds')
              .get(newsItem('feedId'))
              .default({ name: newsItem('feedId'), id: newsItem('feedId') })
              .pluck('id', 'name'),
            title: fullNewsItem('engTitle').default('title stub'),
            sentiment: fullNewsItem('sentiment').default('sentiment stub'),
            timeAdded: fullNewsItem('timeAdded'),
            detectedTopics: fullNewsItem('engDetectedTopics')
              .default({ cat_english: { tags: [] } })('cat_english')('tags')
              .map(tag => [tag(0), tag(1).coerceTo('number')]),
            mediaItemType: getMediaItemType(r, fullNewsItem),
            isLivefeedChunk: fullNewsItem('sourceItemType').default(null).eq('livefeed-logical-chunk'),
            detectedLangCode: fullNewsItem('contentDetectedLangCode').default(null),
          };
        }),
    });
    table
      .get(id)
      .do(item => r.branch(item, getStoryFields(item), item))
      .run()
      .then((result) => {
        if (result === null) {
          response.status(404) // 404 – not found
            .json(result);
        } else {
          response.status(200) // 200 – ok
            .json(result);
        }
        next();
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get story ${id}`,
          description: err,
        });
        next();
      });
  });

  return router;
};
