#!/usr/bin/env python3

import sys, re
from collections import namedtuple, deque
from datetime import datetime, timedelta
from urllib.parse import urljoin
from binascii import crc32
from math import ceil


def item_type(item, classinfo):
    return isinstance(item, classinfo) or (issubclass(type(item), type) and issubclass(item, classinfo))

def item_type_match(item1, item2):
    item1type = issubclass(type(item1), type) and item1 or type(item1)
    item2type = issubclass(type(item2), type) and item2 or type(item2)
    return item1type is item2type

def split_quoted(string, splitchars=',', quotechars='"', limit=None):
    split_start = 0
    quote = ''
    for i, c in enumerate(string):
        if quote:
            if c == quote:
                quote = ''
        elif c in quotechars:
            quote = c
        elif c in splitchars:
            yield string[split_start:i]
            split_start = i+1
    if quote:
        raise ValueError('unmatched quotes in string %s' % string)
    else:
        yield string[split_start:]

def parse_iso8601(datetimestr):
    dt = datetime.strptime(datetimestr.replace(':',''), '%Y-%m-%dT%H%M%S.%f%z')
    if dt.utcoffset() is not None:
        dt -= dt.utcoffset()
    return dt


HLSMedia = namedtuple('Media', 'url, params, source')
HLSStream = namedtuple('Stream', 'url, params, source')

class HLSItem:
    name = ''
    duration = 0
    status = 0
    checksum = -1
    datetime = None
    def __eq__(self, other):
        # return self.checksum == other.checksum and self.name == other.name  # the trick is that checksums will match (-1) only with another tag
        return self.checksum == other.checksum

def guess_epoch_from_url(url):
    # this is a custom hack to guess the epoch of a .ts file from its file name
    # works for data provisioned by the BBC and for DW live streams [UG]
    m = re.search(r'dwstream.*segment(\d+)',url)
    if m: return int(m.group(1))*10
    # code below assumes that the chunk is provisioned by the BBC
    m = re.search(r'-\d+-(\d+)',url)
    if m: return int(m.group(1))
    # failure: return 0
    return 0
    
class HLSSegment(HLSItem):
    def __init__(self, checksum=None, url=None, duration=None, datetime=None,
                 path=None, source_sequence=None, sequence=None):
        self.checksum = checksum
        self.url = url
        self.duration = duration
        self.datetime = datetime
        self.path = path
        self.source_sequence = source_sequence
        self.sequence = sequence
        self.epoch = guess_epoch_from_url(url)
    def __str__(self):
        return 'HLSSegment(checksum=%s, url=%s, duration=%s, datetime=%s)' \
            % (self.checksum, self.url, self.duration, self.datetime)

class HLSTagType(type):
    def __str__(cls):
        return 'Tag: %s' % cls.name
# class HLSTag(HLSItem, metaclass=HLSTagType):
class HLSTag(HLSItem):
    status = 1
    def __str__(self):
        return 'Tag: %s' % self.name
class HLSDiscontinuity(HLSTag):
    # name = 'DISCONTINUITY'
    pass
class HLSPullDiscontinuity(HLSDiscontinuity):
    name = 'PULL-DISCONTINUITY'
class HLSPullError(HLSDiscontinuity):
    name = 'PULL-ERROR'
class HLSSourceDiscontinuity(HLSDiscontinuity):
    name = 'SOURCE-DISCONTINUITY'
class HLSEnd(HLSTag):
    name = 'END'
class HLSSourceEnd(HLSEnd):
    name = 'SOURCE-END'
class HLSChunkEnd(HLSEnd):
    name = 'CHUNK-END'


class HLSIndexException(Exception):
    pass


class SegmentsList(deque):
    def __init__(self):
        self.last_removed_item = None       # point to last deleted item - item before the first in the list (could be the segment)
        self.last_removed_segment = None    # point to last deleted segment - segment before the first in the list
    def popleft(self):
        if not self:
            return
        item = super().popleft()
        self.last_removed_item = item
        if type(item) is HLSSegment:
            self.last_removed_segment = item
        return item
    @property
    def last_item(self):
        if self:
            return self[-1]
    @property
    def first_segment(self):
        for item in self or []:
            if type(item) is HLSSegment:
                return item
    @property
    def last_segment(self):
        for item in reversed(self or []):
            if type(item) is HLSSegment:
                return item
    def extend(self, right, force=False):
        if not right:
            return self
        last = self.last_segment or self.last_removed_segment
        if not last:
            # nothing to extend, copy everything
            super().extend(right)
            return self
        next_dt = last.datetime + timedelta(seconds=last.duration) if last.datetime else None
        items = iter(right)
        extended = False
        for item in items:
            if last == item:
                extended = True
                for item in items:
                    item.datetime = next_dt
                    self.append(item)
                    if next_dt:
                        next_dt += timedelta(seconds=item.duration)
                # break   # just for clarity, can be avoided as the inner for-loop will consume the iterator
        # set last
        # for item in reversed(self):
        #     if type(item) is HLSSegment:
        #         self.last_segment = item
        #         break
        if not extended:
            if not force:
                return
            # check last item, must be either HLSEnd or HLSDiscontinuity
            last = len(self) > 0 and self[-1] or self.last_removed_item
            if last and not isinstance(last, (HLSEnd, HLSDiscontinuity)) and \
                    not (type(last) is type and issubclass(last, (HLSEnd, HLSDiscontinuity))):
                self.append(HLSSourceDiscontinuity)
            super().extend(right)
        return self
    def extendleft(self, left):
        if not left:
            return self
        if self.last_removed_segment:     # cannot extend to left as there were some elements already removed (first represents the middle of list)
            return self
        # find first segment
        first = self.first_segment
        if not first:
            self.extendleft(reversed(left))
            return self
        next_dt = first.datetime
        items = reversed(left)
        for item in items:
            if first == item:
                for item in items:
                    if next_dt:
                        next_dt = item.datetime = next_dt - timedelta(seconds=item.duration)
                    self.appendleft(item)
                    # if type(item) is HLSSegment:
                    #     self.first_segment = segment
                # break   # just for clarity, can be avoided as the inner for-loop will consume the iterator
        return self
    def trimleft(self, until_item, update_datetime=True):
        # pop segments and update datetime
        pop_count = 0
        next_dt = None
        for i,item in enumerate(self):
            if next_dt:
                item.datetime = next_dt
                next_dt += timedelta(seconds=item.duration)
            elif item == until_item:
                pop_count = i + 1
                if not update_datetime or item.datetime: # no need to continue
                    break
                if not item.datetime and until_item.datetime:
                    item.datetime = until_item.datetime
                    next_dt = item.datetime + timedelta(seconds=until_item.duration)
                if not next_dt: # no datetime to extend
                    break
        if pop_count:
            # remove all segments at the left up till matched
            print ('Removing', pop_count, 'segment(s) from initial index (resuming),', len(self)-pop_count, 'segment(s) remain', file=sys.stderr)
            for i in range(pop_count-1):
                super().popleft()
            self.popleft()
        return pop_count
    def apply_end_datetime(self, end_datetime):
        for segment in reversed(self):
            end_datetime = segment.datetime = end_datetime - timedelta(seconds=segment.duration) # set to beginning of segment
        return self
    def print(self):
        for i,item in enumerate(self):
            print(i, item)


class HLSIndex:
    def __init__(self):
        self.base = None
        self.segments = SegmentsList()
        self.media = []
        self.streams = []
        self.unprocessed = []
        self.metadata = {}
        self.complete = False
        self.datetime = None
        self.sequence = None

    @classmethod
    def parse(cls, body, base=None, close=True):
        if type(body) is bytes:
            body = body.decode('utf-8')
        if type(body) is str:
            lines = body.splitlines()
        else:
            lines = body

        get_url = lambda url: (urljoin(base, url) if base else url).replace(' ', '%20')

        index = cls()
        index.base = base
        metadata = index.metadata
        segments = index.segments
        media = index.media
        streams = index.streams
        unprocessed = index.unprocessed
        dt = None

        # only non-empty lines
        lines = (line for line in (line.strip() for line in lines) if line)

        # https://tools.ietf.org/html/draft-pantos-http-live-streaming-13
        # http://www.gpac-licensing.com/2014/12/08/apple-hls-technical-depth/

        try:
            line = None
            head = next(lines).lstrip('# ')
            if head != 'EXTM3U':
                raise HLSIndexException('unknown index format, EXTM3U signature not found')
            for line in lines:
                if line[0] != '#':
                    print('warning: unexpected line:', line, file=sys.stderr)
                    unprocessed.append(line)
                    continue

                directive = line.lstrip('# ')    # remove "#" and space simbols from left
                key, *value = directive.split(':', 1)
                value = value[0] if value else None
                #print(key,value)
                if key == 'EXTINF':
                    duration, *other = value.split(',', 1)
                    # expects segment url next
                    url = next(lines)
                    checksum = crc32(url.encode('utf8'))          # id is hash of source url "as-is"
                    url = get_url(url)
                    # self.segments.append(HLSSegment(checksum=checksum, url=url, duration=float(duration), sequence=sequence, datetime=dt))
                    segments.append(HLSSegment(checksum=checksum, url=url, duration=float(duration), datetime=dt, source_sequence=sequence))
                    if sequence is not None:
                        sequence += 1
                    if dt is not None:
                        dt += timedelta(seconds=float(duration))
                elif key == 'EXT-X-STREAM-INF':
                    params = { k:v.strip('"') for k,v in (param.split('=', 1) for param in split_quoted(value)) }
                    # expects stream url next
                    url = get_url(next(lines))
                    streams.append(HLSStream(url, params, source=line))
                elif key == 'EXT-X-VERSION':
                    metadata[key] = value
                elif key == 'EXT-X-MEDIA-SEQUENCE':
                    index.sequence = sequence = int(value)
                elif key == 'EXT-X-MEDIA':
                    params = { k:v.strip('"') for k,v in (param.split('=', 1) for param in split_quoted(value)) }
                    media.append(HLSMedia(params['URI'], params, source=line))
                elif key == 'EXT-X-PLAYLIST-TYPE':
                    index.type = value
                elif key == 'EXT-X-TARGETDURATION':
                    index.duration = float(value)
                    metadata[key] = value
                elif key == 'EXT-X-ENDLIST':
                    segments.append(HLSSourceEnd)
                    # segments.append(HLSEnd)
                    index.complete = True
                elif key == 'EXT-X-PROGRAM-DATE-TIME':
                    self.datetime = dt = parse_iso8601(value)
                    # metadata[key] = value
                elif key == 'EXT-X-DISCONTINUITY':
                    # http://blog.zencoder.com/2013/01/18/concatenation-hls-to-the-rescue/
                    segments.append(HLSSourceDiscontinuity)
                elif key == 'EXT-X-I-FRAMES-ONLY':
                    raise HLSIndexException('I-Frame playlist not supported')
                elif key == 'EXT-X-I-FRAME-STREAM-INF':
                    # NOTE: i-frame streams not yet supported, so skip them
                    raise HLSIndexException('I-Frame stream info not supported')
                elif key == 'EXT-X-MAP':
                    raise HLSIndexException('EXT-X-MAP not supported')
                elif key == 'EXT-X-BYTERANGE':
                    # see: https://developer.apple.com/library/ios/technotes/tn2288/_index.html
                    br = value.split('@')
                    if len(br) == 2:
                        length, offset = (int(x) for x in br)
                    elif len(br) == 1:
                        length, offset = int(br[0]), None
                    raise HLSIndexException('byte-range not yet supported')
                elif key == 'EXT-X-ALLOW-CACHE':
                    pass
                else:
                    print('warning: unexpected tag:', line, file=sys.stderr)
                    unprocessed.append(line)
        except StopIteration:
            if line is None:
                raise HLSIndexException('empty file')
            raise HLSIndexException('unexpected end of file, last line was: %s' % line)

        if close and hasattr(body, 'close') and callable(body.close):
            body.close()

        return index

    @staticmethod
    def segments_to_index(segments, baseurl='', complete=False):
        output = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:%i' % ceil(max(segments, key=lambda segment: segment.duration).duration),
            '#EXT-X-MEDIA-SEQUENCE:%i' % segments[0].sequence,
        ]
        for segment in segments:
            output.append('#EXTINF:%g,' % segment.duration)
            url = urljoin(baseurl, segment.path) if hasattr(segment, 'path') else urljoin(baseurl, segment.url)
            output.append(url)
        if complete:
            output.append('#EXT-X-ENDLIST')
        return '\n'.join(output)



if __name__ == "__main__":
    pass
