#!/usr/bin/env python3

import sys, os, json, logging
from datetime import datetime, timedelta
from collections import namedtuple
import asyncio
import concurrent.futures

# for debugging
from inspect import currentframe, getframeinfo

# must be installed
import aiohttp
from aiohttp.errors import *

# local
from tail import tail_lines_backwards_yield
from index import HLSSegment, HLSTag, HLSDiscontinuity, HLSPullDiscontinuity, HLSPullError, \
                    HLSSourceDiscontinuity, HLSEnd, HLSSourceEnd, HLSChunkEnd
from storage import Formatter, SegmentsListStorage, AsyncScheduler, download_to_file


logger = logging.getLogger(__name__)

class FileWriter:
    """Wrapper for writable file; main property: auto-open on write, auto-close on directory change"""
    def __init__(self, filename='', dirname='', root='', mode='a'):
        self.root = root
        self.mode = mode
        if filename and os.path.dirname(filename):
            # filename has directory component, split it out
            dirname = os.path.join(dirname, os.path.dirname(filename))
            filename = os.path.basename(filename)
        self._dirname = dirname
        self._filename = filename
        self.handle = None
    def close(self):
        if self.handle:
            self.handle.close()
            self.handle = None
    def open(self):
        if not self.handle:
            dirname = os.path.join(self.root, self._dirname)
            if dirname and not os.path.isdir(dirname):
                os.makedirs(dirname)
            self.handle = open(os.path.join(dirname, self._filename), self.mode)
            # self.handle = open(os.path.join(self.root, self._dirname, self.filename), self.mode)
    @property
    def is_open(self):
        return self.handle is not None
    @property
    def dirname(self):
        return self._dirname
    @dirname.setter
    def dirname(self, dirname):
        if self._dirname != dirname:
            self._dirname = dirname
            self.close()
    @property
    def filename(self):
        return self._filename
    @filename.setter
    def filename(self, filename):
        if self._filename != filename:
            self._filename = filename
            self.close()
    @property
    def path(self):
        return os.path.join(self._dirname, self._filename)
    @path.setter
    def path(self, path):
        filename = os.path.basename(path)
        dirname = os.path.dirname(path)
        if filename != self._filename or dirname != self._dirname:
            self._filename = filename
            self._dirname = dirname
            self.close()
    @property
    def full_path(self):
        """Returns full path to filename"""
        return os.path.join(self.root, self._dirname, self._filename)
    def tell(self):
        if not self.is_open:
            self.open()
        return self.handle.tell()
    def print(self, *args, **kwargs):
        if not self.is_open:
            self.open()
        print(*args, file=self.handle, **kwargs)


class YAMLWriter(FileWriter):
    """Writes infinite list item per line YAML file"""
    datetime_format = '%Y-%m-%d %H:%M:%S'
    @staticmethod
    def json_serialize(obj):
        if isinstance(obj, datetime):
            return obj.strftime(YAMLWriter.datetime_format)
        raise TypeError ("Type is not JSON serializable")
    def __init__(self, filename='', dirname='', root='', mode='a'):
        super().__init__(filename, dirname, root, mode)
    def write(self, item):
        if type(item) is not str:
            item = json.dumps(item, default=self.json_serialize, ensure_ascii=False)
        else:
            # NOTE: ideally the item must be checked here, that it does not contain newlines and possibly other format breaking symbols,
            # and if so, must be wrapped in quotes
            pass
        self.print('- %s' % item, flush=True)


class YAMLReader:
    """Infinite list item per line YAML file reader backwards from end (tail)"""
    datetime_format = '%Y-%m-%d %H:%M:%S'
    datetime_formats = (
        datetime_format,
        # '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%d %H:%M:%S %Z',
        '%Y-%m-%dT%H:%M:%S',
        '%Y-%m-%dT%H:%M:%S%Z',
        '%Y-%m-%dT%H:%M:%S.%f',
        '%Y-%m-%dT%H:%M:%S.%f%Z'
    )
    # # some configuration for tuning tailing 
    # initial_lines = 10
    # chunk_lines = 10
    # max_lines = 20
    @classmethod
    def parse_datetime(cls, string, formats=datetime_formats):
        # for fmt in cls.datetime_formats:
        for fmt in formats:
            try:
                return datetime.strptime(string, fmt)
            except ValueError:
                pass
    @classmethod
    def parse_line(cls, line):
        line = line.strip()
        if line.startswith('- '):
            # line = line.lstrip('- ')
            line = line[2:]
            if len(line) >= 2:
                if (line[0] == '[' and line[-1] == ']') or (line[0] == '{' and line[-1] == '}'):
                    return json.loads(line)
                elif line[0] == '"' and line[-1] == '"':
                    return json.loads(line)
                elif line[0] == "'" and line[-1] == "'":
                    return line[1:-1]
            return line # return as string whatever is found
        # elif line == '---':
        #     pass
        # else:
        #     raise Exception("not a valid YAML item")
    @classmethod
    def yield_backwards(cls, full_path, skip_none=True):
        """Yield items backwards from end of file, no exception if file not found"""
        try:
            with open(full_path, 'rb') as f:
                for line in tail_lines_backwards_yield(f, initial_lines=10, chunk_lines=10,
                                                       max_lines=20, seek=-1):
                    item = cls.parse_line(line)
                    if skip_none and not item:
                        continue
                    yield item
        except FileNotFoundError:
            # this is not an "error"
            # logger.critical("Missing file: %s"%full_path)
            pass


class YAMLIndexedItemListWriter:
    """Writes pair of YAML files to specified directory: list of items and index for this list of items (for faster searching)"""
    list_filename = "segments.yaml"
    index_filename = "segments.index.yaml"
    IndexEntry = namedtuple('IndexEntry', 'key, canonical_key, position')
    def __init__(self, dirname='', root='', index=True):
        self.yaml_list = YAMLWriter(self.list_filename, dirname, root)
        self.yaml_index = YAMLWriter(self.index_filename, dirname, root) if index else None
        self.last_key = None
        self.last_item = None   # any type: either string or object
        self.last_object = None
        self.load()
    @property
    def dirname(self):
        return self.yaml_list.dirname
    @dirname.setter
    def dirname(self, dirname):
        self.yaml_list.dirname = dirname
        if self.yaml_index:
            self.yaml_index.dirname = dirname
        self.load()
    def close(self):
        self.yaml_list.close()
        if self.yaml_index:
            self.yaml_index.close()
    def load(self):
        self.last_item = None
        self.last_object = None
        if self.yaml_list.dirname is None:
            return
        for item in YAMLReader.yield_backwards(self.yaml_list.full_path):
            if self.last_item is None:
                self.last_item = item
            if type(item) is not str:
                self.last_object = item
                break
        if self.yaml_index:
            self.last_key = None
            for item in YAMLReader.yield_backwards(self.yaml_index.full_path):
                if type(item) is list:
                    self.last_key = self.IndexEntry(*item).key
                    break
    def update_index(self, key=None, canonical_key=None):
        """Updated YAML indexed list index, only when an existing index is opened"""
        if key and self.yaml_index and self.yaml_index.dirname is not None and key != self.last_key:
            index_entry = self.IndexEntry(key=key, canonical_key=canonical_key, position=self.yaml_list.tell())
            self.yaml_index.write(index_entry)
            self.last_key = key
    def write(self, item, key=None, canonical_key=None):
        """Write item to YAML indexed list, index entry depends on key, if key not defined, index is left alone even if exists"""
        if key is not None:
            self.update_index(key, canonical_key)
        self.yaml_list.write(item)


class YAMLChunkList(YAMLWriter):
    """Writes chunks in YAML file similar to Segments list etc."""
    filename = "chunks.yaml"
    # Chunk = namedtuple('Chunk', 'sequence, start, end, duration, path')
    ChunkAction = namedtuple('ChunkAction', 'action, sequence, datetime, path')
    def __init__(self, dirname='', root='', metadata=None, **kwargs):
        super().__init__(self.filename, dirname, root=root)
        # self.last_chunk = None
        self.metadata = metadata
        self.prev_chunk_end = None
        self._last_action = None
        self.load()
    @property
    def last_action(self):
        return self._last_action
    @last_action.setter
    def last_action(self, action):
        if self._last_action and self._last_action.action == 'end':
            self.prev_chunk_end = self._last_action
        self._last_action = action
    @property
    def dirname(self):
        return super().dirname
    @dirname.setter
    def dirname(self, dirname):
        super().dirname = dirname
        self.load()
    def load(self):
        for i,item in enumerate(YAMLReader.yield_backwards(self.full_path)):
            # item[1] = YAMLReader.parse_datetime(item[1])   # parse start datetime
            # item[2] = YAMLReader.parse_datetime(item[2])   # parse end datetime
            # self.last_chunk = self.Chunk(*item)
            item[2] = YAMLReader.parse_datetime(item[2])   # parse end datetime
            if i == 0:
                self.last_action = self.ChunkAction(*item)
            else:
                prev_action = self.ChunkAction(*item)
                if prev_action.action == 'end':
                    self.prev_chunk_end = prev_action
                    break
    def write(self, **item):
        # item['sequence'] = self.last_chunk.sequence+1 if self.last_chunk else 0
        # item['duration'] = (item['end']-item['start']).seconds
        # item = self.Chunk(**item)
        # print('Completed', item)
        # super().write(item)
        # self.last_chunk = item

        item['sequence'] = self.last_action.sequence+(1 if self.last_action.action == 'end' else 0) if self.last_action else 0
        # item['duration'] = (item['end']-item['start']).seconds
        item = self.ChunkAction(**item)
        stream_id = self.metadata.get('id') if self.metadata and isinstance(self.metadata, dict) else self.metadata
        print('Stream %s: registering chunk action=%s at sequence=%i, datetime=%s, path=%s' % ((stream_id,)+item))
        super().write(item)
        self.last_action = item


class YAMLChunker:
    chunk_path_template = '%Y-%m-%d/%H%M%S.yaml'
    ChunkSegment = namedtuple('ChunkSegment', 'sequence, duration, datetime, path')
    def __init__(self, formatter, notifier=None, list_dirname='',
                 chunk_dirname='chunks', root='', min_duration=5*60,
                 metadata=None, **kwargs):
        self.formatter = formatter
        self.notifier = notifier
        self.min_duration = min_duration
        self.chunk_path_template = os.path.join(chunk_dirname, self.chunk_path_template)
        self.metadata = metadata
        self.list = YAMLChunkList(list_dirname, root, metadata=metadata)
        self.list.load()
        # chunklist filename: /chunks/YYYYMMDD/HHMMSS.yaml <- 
        self.start = None
        self.projected_end = None
        self.chunk = YAMLWriter(root=root)
        if self.list.last_action and self.list.last_action.action == 'start':
            self.chunk.path = self.list.last_action.path
            self.start = self.list.last_action.datetime
            self.projected_end = self.start + timedelta(seconds=self.min_duration)
        self._last_item = None
    def notify(self, start, end, path):
        if self.notifier:
            prev_path = self.list.prev_chunk_end.path if self.list.prev_chunk_end else None
            next_path = end.strftime(self.chunk_path_template)
            self.notifier(path=path, start=start, end=end, prev_path=prev_path, next_path=next_path)
    @classmethod
    def read_chunk_segments(cls, path, noexcept=True):
        try:
            segments = []
            with open(path, 'r') as f:
                for line in f:
                    item = YAMLReader.parse_line(line)
                    item[2] = YAMLReader.parse_datetime(item[2])   # parse datetime
                    segments.append(cls.ChunkSegment(*item))
            return segments
        except FileNotFoundError:
            if not noexcept:
                raise
    @property
    def last_item(self):
        if self._last_item is not None:
            return self._last_item
        for item in YAMLReader.yield_backwards(self.chunk.full_path):
            item[2] = YAMLReader.parse_datetime(item[2])   # parse datetime
            self._last_item = self.ChunkSegment(*item)
            return self._last_item
    @last_item.setter
    def last_item(self, value):
        self._last_item = value
    def end(self):
        """Finish chunk without item"""
        # NOTE: use self.last_item to determine end time
        if self.start:
            chunk_end_datetime = self.last_item.datetime+timedelta(seconds=self.last_item.duration)
            self.list.write(action='end', datetime=chunk_end_datetime, path=self.chunk.path)
            self.chunk.close()
            self.notify(start=self.start, end=chunk_end_datetime, path=self.chunk.path)
            # prepare for next chunk
            self.start = None
            self.projected_end = None
            # self.last_item = None # needed ?
    def write(self, item):
        # NOTE: checks if item is past some projected endtime, other option:
        # count the total duration of added segments, if past limit...
        assert item is not None
        if self.start is None or (self.projected_end and self.projected_end <= item.datetime):
            if self.start:
                # notify a chunk is complete here
                # can happen if chunks are missing
                # self.list.write(start=self.start, end=self.last_item.datetime + timedelta(seconds=self.last_item.duration), path=self.chunk.path)
                logger.info("Adding chunk %s/%s to list."%(self.chunk.root,self.chunk.path))
                chunk_end_datetime = self.last_item.datetime+timedelta(seconds=self.last_item.duration)
                self.list.write(action='end', datetime=chunk_end_datetime, path=self.chunk.path)
                self.notify(start=self.start, end=chunk_end_datetime, path=self.chunk.path)
            self.start = item.datetime
            self.projected_end = self.start + timedelta(seconds=self.min_duration)
            self.chunk.path = self.start.strftime(self.chunk_path_template)
            self.list.write(action='start', datetime=self.start, path=self.chunk.path)
        path = self.formatter.path(item)
        self.chunk.write([item.sequence, item.duration, item.datetime, path])
        # self.chunk.write([item.sequence, item.source_sequence, item.duration, item.datetime, path, item.checksum])
        item_end = item.datetime + timedelta(seconds=item.duration)
        if self.projected_end and self.projected_end <= item_end:
            self.chunk.close()
            # notify a chunk is complete here
            # self.list.write(start=self.start, end=item_end, path=self.chunk.path)
            self.list.write(action='end', datetime=item_end, path=self.chunk.path)
            self.notify(start=self.start, end=item_end, path=self.chunk.path)
            # prepare for next chunk
            self.start = None
            self.projected_end = None
        self.last_item = item


class YAMLFormatter(Formatter):
    def __init__(self, path_template, base_template='', index_key_template=None, **kwargs):
        super().__init__(path_template)
        self.base_template = base_template
        self.index_key_template = index_key_template
        self.args.update(kwargs)
    def __len__(self):
        return len(self.path_template.split(os.sep))
    def split(self, depth=1, index_key=True):
        """create new class instance by splittin path template at some depth"""
        path_items = self.path_template.split(os.sep)
        path_template = os.path.join(*path_items[depth:])
        base_template = os.path.join(self.base_template, os.path.join(*(path_items[0:depth] or [''])))
        index_key_template = os.path.dirname(path_template).split(os.sep)[0] if index_key else None
        return self.__class__(path_template, base_template, index_key_template, **self.args)
    def base(self, item, root=None):
        base = self.format(self.base_template, item)
        return os.path.join(root, base) if root else base
    def index_key(self, item):
        return self.format(self.index_key_template, item) if self.index_key_template else None


class YAMLSegmentsListWriter(YAMLIndexedItemListWriter):
    """Use case specific YAML indexed item writer"""
    Segment = namedtuple('Segment', 'sequence, source_sequence, duration, datetime, path, checksum')
    def __init__(self, formatter, chunker=None, root=''):
        super().__init__(None if formatter.base_template else '', root, bool(formatter.index_key_template))
        self.formatter = formatter
        self.chunker = chunker
    @property
    def last_segment(self):
        return self.last_object
    @last_segment.setter
    def last_segment(self, segment):
        self.last_object = segment
    def load(self):
        # overload load() to convert last_item and last_object (and hence also last_segment) to correct types
        super().load()
        last_object = None
        last_item = None
        if self.last_item is not None and self.last_item is not self.last_object:
            assert type(self.last_item) is str, "last_item must be string at this point"
            if self.last_item == HLSSourceDiscontinuity.name:
                last_item = HLSSourceDiscontinuity
            elif self.last_item == HLSPullDiscontinuity.name:
                last_item = HLSPullDiscontinuity
            elif self.last_item == HLSChunkEnd.name:
                last_item = HLSChunkEnd
            elif self.last_item == HLSEnd.name:
                last_item = HLSEnd
            else:
                last_item = self.last_item # TODO: exception or just HLSTag or HLSUnknownTag, for not the string
        if self.last_object is not None:
            # HLSSegment: sequence, source_sequence, duration, datetime, path, checksum
            last_object = self.last_object
            last_object[3] = YAMLReader.parse_datetime(last_object[3])   # parse datetime
            last_object = self.Segment(*last_object)
        if last_object is not None:
            self.last_object = last_object
            if self.last_item is self.last_object:
                self.last_item = last_object
            elif last_item is not None:
                self.last_item = last_item
        elif last_item is not None:
            self.last_item = last_item
    def resume_from(self, item):
        """open lists according to given item"""
        self.dirname = self.formatter.base(item)
    def write(self, item):
        """change list dirname if required according to item and write item to list"""
        if item.datetime:
            newdirname = self.formatter.base(item)
            if self.dirname != newdirname:
                if self.dirname is not None:
                    self.write(HLSChunkEnd) # before changing directory
                    # super().write(HLSChunkEnd.name) # before changing directory
                self.dirname = newdirname
        if self.yaml_index:
            canonical_key = item.datetime if item.datetime else None
            key = self.formatter.index_key(item) if item.datetime else None
            self.update_index(key, canonical_key)
        if type(item) is HLSSegment:
            if self.chunker:
                self.chunker.write(item)
            path = self.formatter.path(item)
            yaml_item = [item.sequence, item.source_sequence, item.duration, item.datetime, path, item.checksum]
            self.last_segment = item
        elif isinstance(item, HLSTag) or (type(item) is type and issubclass(item, HLSTag)):
            if item is self.last_item:
                # avoid of having multiple instances of the same tag at end of list
                return
            # if isinstance(item, HLSEnd) or (type(item) is type and issubclass(item, HLSEnd)):
            if isinstance(item, (HLSSourceEnd, HLSDiscontinuity)) or (type(item) is type and issubclass(item, (HLSSourceEnd, HLSDiscontinuity))):
                if self.chunker:
                    self.chunker.end()
            yaml_item = item.name
        self.last_item = item
        super().write(yaml_item)


class SegmentsListYAMLStorage(SegmentsListStorage):
    def __init__(self, root, formatter=None, chunk_notifier=None, ext='ts',
                 chunk_size=5*60, metadata=None, **kwargs):
        super().__init__()
        self.root = root
        self.metadata = metadata
        if not formatter:
            # formatter = YAMLFormatter('%Y-%m-%d/%H/{seq}.{ext}', '', '%Y-%m-%d/%H', ext=ext)
            formatter = YAMLFormatter('%Y-%m-%d/%H/{timestamp}.{ext}', '', '%Y-%m-%d/%H', ext=ext)
        else:
            formatter['ext'] = ext
        self.formatter = formatter
        for key,value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)
            else:
                raise ValueError('unknown keyword argument: %s' % key)
        chunker = YAMLChunker(formatter, notifier=chunk_notifier, root=root,
                              min_duration=chunk_size, metadata=metadata)
        self.master = YAMLSegmentsListWriter(formatter, chunker=chunker, root=root)
        self.sublists = [YAMLSegmentsListWriter(formatter.split(depth), root=root)
                         for depth in range(1,len(formatter))]
    def load(self):
        self.master.load()
    def close(self):
        self.master.close()
        for lst in self.sublists:
            lst.close()
    @property
    def last_item(self):
        return self.master.last_item
    @property
    def last_segment(self):
        return self.master.last_segment
    def write(self, item):
        self.master.write(item)
        for lst in self.sublists:
            lst.write(item)
    def resume(self):
        # open sublists to be resumed
        last = self.last_segment
        if last:
            last = HLSSegment(last.checksum, datetime=last.datetime)
            for lst in self.sublists:
                lst.resume_from(last)


class YAMLSegmentsStorage:

    def __init__(self, root, ext='ts', chunk_notifier=None, parallel_downloads=4,
                 chunk_size=5*60, loop=None, metadata=None, **kwargs):

        # create destination directory if not exist
        if not os.path.isdir(root):
            os.makedirs(root)

        self.root = root
        self.list = SegmentsListYAMLStorage(root, chunk_notifier=chunk_notifier,
                                            chunk_size=chunk_size, ext='ts',
                                            metadata=metadata)
        self.formatter = self.list.formatter
        # self.list.load()

        self.sequence = self.list.last_segment.sequence+1 if self.list.last_segment else 0
        self.loop = loop
        self.metadata = metadata
        self.scheduler = AsyncScheduler(parallel_downloads, loop=loop)

    @property
    def stop(self):
        return self.scheduler.stop
    @stop.setter
    def stop(self, value):
        self.scheduler.stop = value

    async def download(self, item):

        # if not item.datetime:
        #     raise ValueError('item datetime not set')
        # item.path = item.datetime.strftime(self.path_template).format(seq=self.sequence)

        path = self.formatter.path(item)
        path = os.path.join(self.root, path)
        # path = os.path.join(self.root, item.path)
        # dirname = os.path.dirname(path)
        # if not os.path.isdir(dirname):
        #     os.makedirs(dirname)

        stream_id = self.metadata.get('id') if self.metadata and isinstance(self.metadata, dict) else self.metadata
        response = None
        exception = None
        error_sleep = 5
        for i in range(4):
            try:
                if self.scheduler.stop:
                    return
                response = await download_to_file(item.url, path)
                if response.status == 200:
                    self.list.done(item)
                    print(' ', item.source_sequence, '==>', path)
                    return
            except (ClientOSError, ClientResponseError, ServerDisconnectedError, concurrent.futures.TimeoutError) as e:
                # if self.stop:
                #     return
                exception = e
                print('Stream %s: network error:' % stream_id, e)
                print('Stream %s: will retry in' % stream_id, error_sleep, 'seconds')
                await asyncio.sleep(error_sleep, loop=self.loop)
                if error_sleep < 60:
                    error_sleep *= 2    # 10s, 20s, 40s, 1m20s
            except Exception as e:
                print('Stream %s: UNEXPECTED ERROR:' % stream_id, e)
                self.list.cancel(item)
                print('  =X=>', path)
                return
            # except KeyboardInterrupt:
            #     print('downloader keyboard interrupt')
            #     raise

        if response:
            print('ERROR', response.status, '  =X=>', path)
        elif exception:
            print('ERROR (', str(exception), ')  =X=>', path)
        else:
            print('UNKNOWN ERROR  =X=>', path)
        self.list.cancel(item)
        # self.list.replace(item, HLSPullDiscontinuity)
        # self.list.replace(item, HLSPullError)

    async def wait(self):
        if self.downloaders:
            print('Waiting downloaders to complete')
            await asyncio.wait(self.downloaders, loop=None)     # wait for downloads to complete
            # self.downloaders.clear()                          # must be already self-cleaned
        self.filelist.close()                                   # closed only when all downloads are finished

    def store(self, item):
        self.list.promise(item)
        # check type
        if isinstance(item, HLSSegment) or issubclass(item, HLSSegment):
            item.sequence = self.sequence
            self.sequence += 1
            if not item.datetime:
                raise ValueError('item datetime not set')
            self.scheduler(self.download(item))



if __name__ == "__main__":
    pass
