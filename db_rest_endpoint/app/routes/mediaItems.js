import { Router } from 'express';
import _ from 'underscore';
import { reportError } from '../common/errorReporting.js';
import { getMediaItemType } from '../common/utils.js';


export default (r, topLevelPath) => { // eslint-disable-line
  const table = r.table('newsItems');
  const router = new Router();

  router.get('/', (request, response, next) => {
    reportError(response, {
      httpStatusCode: 501,
      message: 'Getting all mediaItems not implemented; go through /stories/{{story-id}}',
    });
    next();
  });

  router.get('/:id', (request, response, next) => {
    const id = request.params.id;

    const getEntityMentions = (newsItem, entityField) => (
      newsItem(entityField).default({ entities: [] })('entities')
        .map(entity => [
          entity('entity')('id'),
          entity('mentions').map(mention => mention.pluck('startPosition', 'endPosition', 'text')),
        ])
        .coerceTo('object')
    );

    const getItemFields = newsItem => ({
      // [id, source, originalLanguage,
      //  title, summary, teaser, mainText,
      //  originalMultiMedia: {videoURL, audioURL, photoURL}
      //  transcript:{text, timestampsAndConfidences},
      //  entities, sentiment, keywords
      //  storyId
      //  timeAdded, timeChanged,]
      id: newsItem('id'),
      source: r.table('feeds')
        .get(newsItem('feedId'))
        .default({ name: newsItem('feedId'), id: newsItem('feedId') })
        .pluck('id', 'name'),
      mediaItemType: getMediaItemType(r, newsItem),
      isLivefeedChunk: newsItem('sourceItemType').default(null).eq('livefeed-logical-chunk'),
      detectedLangCode: newsItem('contentDetectedLangCode').default(null),
      title: {
        original: newsItem('sourceItemTitle').default(null),
        english: newsItem('engTitle').default(null),
      },
      summary: newsItem('highlightItems')
        .default([])
        .map(highlightItem => highlightItem('highlight').default('')),
      teaser: {
        original: newsItem('sourceItemTeaser').default(null),
        english: newsItem('engTeaser').default(null),
      },
      mainText: {
        original: newsItem('sourceItemMainText').default(null),
        english: newsItem('engMainText').default(null),
      },
      originalMultiMedia: {
        videoURL: newsItem('sourceItemVideoURL').default(null),
        audioURL: newsItem('sourceItemAudioURL').default(null),
        photoURL: newsItem('sourceItemPhotoURL').default(null),
      },
      transcript: {
        original: {
          text: newsItem('contentTranscribedPunctuatedMainText')
            .default(null),
          wordTimestampsAndConfidences: newsItem('contentTranscribedMainText')
            .default({ segments: [] })('segments')
            .fold([], (acc, segment) => acc.union(segment)),
        },
        english: {
          text: newsItem('engTranscript').default(null),
          wordTimestampsAndConfidences: [],
        },
      },
      namedEntities: {
        entities: r.expr(['engTeaserEntities', 'engMainTextEntities', 'engTranscriptEntities'])
          .fold({}, (acc, key) => (
            acc.merge(
              newsItem(key).default({ entities: [] })('entities')
                .fold({}, (acc2, entity) => acc2.merge(r.object(entity('entity')('id'), entity('entity')))))
          )),
        mentionsIn: {
          title: getEntityMentions(newsItem, 'engTitleEntities'),
          summary: getEntityMentions(newsItem, 'engSummaryEntities'),
          teaser: getEntityMentions(newsItem, 'engTeaserEntities'),
          mainText: getEntityMentions(newsItem, 'engMainTextEntities'),
          transcript: getEntityMentions(newsItem, 'engTranscriptEntities'),
        },
      },
      relationships: {
        teaser: newsItem('engTeaserRelationships').default(null),
        mainText: newsItem('engMainTextRelationships').default(null),
      },
      detectedTopics: newsItem('engDetectedTopics')
        .default({ cat_english: { tags: [] } })('cat_english')('tags')
        .map(tag => [tag(0), tag(1).coerceTo('number')]),
      sentiment: 'sentiment stub',
      keywords: newsItem('engKeywords').default([]),
      storyId: newsItem('engStorylineId').default(null),
      timeAdded: newsItem('timeAdded').default(null),
      timeLastChanged: newsItem('summaPlatformProcessingMetadata')
        .default({})
        .values()
        .filter(update => update.hasFields('updateTime'))
        .fold(newsItem('timeAdded').default(r.now()),
              (acc, update) => r.max([acc, update('updateTime')])),
      prevId: newsItem('prevId').default(null),
      nextId: newsItem('nextId').default(null),
    });

    table
      .get(id)
      .do(item => r.branch(item, getItemFields(item), item))
      .run()
      .then((result) => {
        if (result === null) {
          response.status(404) // 404 – not found
            .json(result);
        } else {
          // replace livestreem url
          // to point to the forwarding address from docker-compose entrypoint service
          // see docker-compose.yaml service 'entrypoint'
          if (result.originalMultiMedia.videoURL) {
            result.originalMultiMedia.videoURL = result.originalMultiMedia.videoURL
              .replace('http://livestream_cache_and_chunker:6000/',
                '/video-chunks/');
          }
          response.status(200) // 200 – ok
            .json(result);
        }
        next();
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to get mediaItem ${id}`,
          description: err,
        });
        next();
      });
  });

  router.post('/withNamedEntity', (request, response, next) => {
    const rawRequestContent = request.body;

    if (!rawRequestContent) {
      response.sendStatus(400).send('Missing request body'); // 400 - Bad Request
      next();
    }

    if (!rawRequestContent.namedEntity && _.isString(rawRequestContent.namedEntity)) {
      response.status(400).send('Missing namedEntity of type String'); // 400 - Bad Request
      next();
    }

    table
      .getAll(rawRequestContent.namedEntity.toLowerCase(), { index: 'namedEntities' })
      .coerceTo('array')
      .do(newsItems => ({
        totalCount: newsItems.count(),
        latest100: newsItems.orderBy(r.desc('timeAdded')).pluck('id', 'engTitle', 'timeAdded'),
      }))
      .run()
      .then((result) => {
        response.status(200) // 200 – ok
          .json(result);
        next();
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get mediaItems with namedEntity',
          description: err,
        });
        next();
      });
  });

  return router;
};
