
export const hourInSeconds = 60 * 60;

export function getMediaItemType(r, item) {
  const rawType = item('sourceItemType').default(null);
  return r.branch(rawType.eq('livefeed-logical-chunk'), 'Video', rawType);
}

export function getFormatedNewsItems(r, newsItems) {
  return newsItems
    .map((newsItem) => {
      const fullNewsItem = r.table('newsItems')
        .get(newsItem('id'));

      const feedId = newsItem('feedId').default(null);

      return {
        id: newsItem('id'),
        source: r.table('feeds')
          .get(feedId)
          .default({ name: feedId, id: feedId })
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
    })
    .coerceTo('array');
}

export function getHourOffsetBin(r, currentTime, time) {
  return time.sub(currentTime)
    .div(hourInSeconds)
    .ceil()
    .coerceTo('string') // coerce to string, because only strings can be used as indexes
    .do(val => r.branch(val.eq('-0.0'), '-0', val)); // because -0 by to string is -0.0
}
