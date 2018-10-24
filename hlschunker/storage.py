#!/usr/bin/env python3

import os, json, traceback
from collections import deque
import asyncio
import concurrent.futures
import time

# must be installed
import aiohttp
from aiohttp.errors import *

from index import *


HTTPResponse = namedtuple('HTTPResponse', 'headers, status')
HTTPResponseContent = namedtuple('HTTPResponseContent', 'content, headers, status')

if hasattr(aiohttp.client, 'URL'):
    # compatibility of aiohttp 1.1+ with some servers/services using urls with '@' (like DW)
    import yarl
    def prep_url(url):
        if '@' in url:
            return yarl.URL(url, encoded=True)
        return url
else:
    prep_url = lambda url: url

async def download_to_file(url, path, method='GET'):
    async with aiohttp.ClientSession() as session:
        response = await session.request(method, prep_url(url))
        try:
            size = os.path.getsize(path)
        except OSError:
            size = -1 
        try:
            if response.status != 200:  # TODO: other possible error codees ?
                return HTTPResponse(response.headers, response.status)
                # return
                #return HTTPDownload(False, False, response.headers, response.status)
            if response.headers.get('CONTENT-LENGTH', -2) != size:
                content = await response.content.read()
                try:
                    dirname = os.path.dirname(path)
                    if not os.path.isdir(dirname):
                        os.makedirs(dirname)
                    with open(path, 'wb') as f:
                        if type(content) is str:
                            content = content.encode('utf8')
                        f.write(content)
                    #return HTTPDownload(True, True, response.headers, response.status)
                except:
                    # NOTE: debug
                    traceback.print_exc()
                    return HTTPResponse(None, -1)
                    #return HTTPDownload(False, False, response.headers, response.status)
            # content = content.decode('utf8', errors='ignore')
            return HTTPResponse(response.headers, response.status)
            #return HTTPDownload(True, False, response.headers, response.status)
        finally:
            response.close()

async def request(url, params=None, data=None, method=None, headers=None):
    if method is None:
        method = 'GET' if data is None else 'POST'
    async with aiohttp.ClientSession() as session:
        async with session.request(method, prep_url(url), params=params, data=data, headers=headers) as response:
            content = await response.content.read()
            # content = content.decode('utf8', errors='ignore')
            # response.close()
            return HTTPResponseContent(content, response.headers, response.status)



class AsyncScheduler:
    def __init__(self, max_count=None, loop=None):
        self.max_count = max_count
        self.loop = loop
        self.coroutines = deque()
        self.tasks = set()
        self.stop = False
    async def wait(self, stop=None):
        if stop is not None:
            self.stop = stop
        if self.tasks:
            for coroutine in self.coroutines:
                asyncio.ensure_future(coroutine).cancel()
            # print(asyncio.gather(iter(self.coroutines)).cancel())
            await asyncio.wait(self.tasks, loop=self.loop)   # wait for tasks to complete
    def __bool__(self):
        return bool(self.tasks) # any running coroutines
    def __len__(self):
        return len(self.tasks) + len(self.coroutines)
    def __call__(self, coroutine=None):
        if coroutine is not None:
            self.coroutines.append(coroutine)
        # while len(self.tasks) < self.max_count and self.coroutines:
        if (self.max_count is None or len(self.tasks) < self.max_count) and self.coroutines:
            coroutine = self.coroutines.popleft()
            task = asyncio.ensure_future(coroutine, loop=self.loop)
            self.tasks.add(task)
            task.add_done_callback(lambda task: self.tasks.remove(task) or self.stop or self())


class ChunkNotifier:
    def __init__(self, endpoint, metadata=None, loop=None, retry_sleep=30, **kwargs):
        self.endpoint = endpoint
        self.metadata = {} if metadata is None else metadata
        self.scheduler = AsyncScheduler(1, loop=loop)   # one by one
        self.retry_sleep = retry_sleep
    async def send(self, data):
        stream_id = self.metadata.get('id') if self.metadata and isinstance(self.metadata, dict) else self.metadata
        exception = None
        response = None
        for i in range(10):
            if self.scheduler.stop:
                break
            try:
                response = await request(self.endpoint, data=json.dumps(data, ensure_ascii=False), headers={'Content-Type': 'application/json'})
                if response.status == 200 or response.status == 201:
                    print('Chunk for stream %s successfully submitted' % (self.metadata and self.metadata.get('id')))
                    break
                print('Stream %s: error submitting chunk, HTTP response code:' % stream_id, response.status, file=sys.stderr)
            except (ClientOSError, ClientResponseError, ServerDisconnectedError, concurrent.futures.TimeoutError) as e:
                print('Stream %s: error submitting chunk at this time, will try again after %i seconds.'
                        % (stream_id, self.retry_sleep), file=sys.stderr)
                # print('Stream %s: error was:' % stream_id, e, file=sys.stderr)
                exception = e
            except Exception as e:
                print('Stream %s: unknown error submitting chunk:' % stream_id, e, file=sys.stderr)
                exception = e
            await asyncio.sleep(self.retry_sleep)
        print('Stream %s: giving up submitting chunk, last error was:' % stream_id,
                (exception or response and 'HTTP response %s'+str(response.status)), file=sys.stderr)
    async def notify(self, path, start=None, end=None):
        data = dict(self.metadata, path=path)
        await self.send(data)
    def __call__(self, path, start=None, end=None, **kwargs):
        self.scheduler(self.notify(path=path, start=start, end=end, **kwargs))


class SegmentsListStorage:
    def __init__(self, timeout=300):    # default timeout: 5 minutes
        self.timeout = timeout  # failsafe: promised items will be canceled after timeout is reached
        self.pending = deque()
    def promise(self, item):
        if type(item) is HLSSegment:
            item.status = 0
            item.timeout = time.time() + self.timeout   # downloadable HLS segment items will be automatically cancelled if the timeout is reached
            # NOTE: HLSTag and subclasses are expected to have always status = 1
        self.pending.append(item)
    def cancel(self, item):
        item.status = -1
        self.flush()
    def done(self, item):
        item.status = 1
        self.flush()
    def replace(self, item, replacement):
        try:
            i = self.pending.index(item)
            self.pending[i] = replacement
            flush()
            return True
        except ValueError:
            return False
    def flush(self):
        now = time.time()
        while self.pending and (type(self.pending[0]) is not HLSSegment or self.pending[0].status != 0 or self.pending[0].timeout >= now):
            item = self.pending.popleft()
            if type(item) is HLSSegment and item.status == 0 and item.timeout >= now:
                print('warning: segments item timeout reached, item cancelled')
                item.status = -1    # timeout reached, mark as cancelled
            self.write(item)
    def write(self, item):
        raise NotImplemented('write must be implemented')


class Formatter:
    def __init__(self, path_template, ext='ts', **kwargs):
        self.path_template = path_template
        self.args = dict(ext=ext)
        self.args.update(kwargs)
    def __getitem__(self, name):
        return self.args[name]
    def __setitem__(self, name, value):
        self.args[name] = value
    def format(self, template, item, **kwargs):
        if template:
            if not item.datetime:
                raise ValueError('item datetime not set')
            args = dict(self.args)
            seq = None
            if hasattr(item, 'sequence'):
                seq = args['seq'] = item.sequence
            if hasattr(item, 'epoch') and item.epoch:
                t = time.strftime("%Y-%m-%d_%H-%M-%S", time.gmtime(item.epoch))
                args['timestamp'] = t
            elif seq:
                args['timestamp'] = seq
            args.update(kwargs)
            return item.datetime.strftime(template).format_map(args)
        return template
    def path(self, item):
        return self.format(self.path_template, item)


class SegmentsStorage:

    def __init__(self, root, segments_list, ext='ts', formatter=None, parallel_downloads=4, loop=None):
        self.root = root

        # create destination directory if not exist
        if not os.path.isdir(self.root):
            os.makedirs(self.root)

        if formatter is None:
            # formatter = formatter('%Y-%m-%d/%H/{seq}.{ext}', ext=ext)
            formatter = formatter('%Y-%m-%d/%H/{timestamp}.{ext}', ext=ext)
        elif type(formatter) is str:
            formatter = formatter(formatter, ext=ext)
        else:
            formatter['ext'] = ext
        self.formatter = formatter
        self.list = segments_list

        self.list.load()
        self.sequence = self.list.last_segment.sequence+1 if self.list.last_segment else 0
        self.loop = loop
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

        exception = None
        response = None
        error_sleep = 5
        for i in range(10):
            try:
                if self.scheduler.stop:
                    break
                response = await download_to_file(item.url, path)
                if response.status == 200:
                    self.list.done(item)
                    print('  ==>', path)
                    return
            except (ClientOSError, ClientResponseError, ServerDisconnectedError, concurrent.futures.TimeoutError) as e:
                # if self.stop:
                #     return
                exception = e
                print('network error:', e)
                print('will retry in', error_sleep, 'seconds')
                await asyncio.sleep(error_sleep, loop=self.loop)
                if error_sleep < 60:
                    error_sleep *= 2    # 10s, 20s, 40s, 1m20s
            except Exception as e:
                print('UNEXPECTED ERROR:', e)
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
