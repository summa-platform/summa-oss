#!/usr/bin/env python3

import sys, os, json
from collections import namedtuple
from datetime import datetime, timedelta
import asyncio
import logging
import concurrent.futures

# for debugging
from inspect import currentframe, getframeinfo

# must be installed
import aiohttp
from aiohttp.errors import *

# local
from index import *
from yaml_storage import *
from storage import request as download

logger = logging.getLogger(__name__)

class HLSPull:

    def __init__(self, url, root, chunk_notifier=None, chunk_size=5*60, ext='ts',
                 parallel_downloads=4, loop=None, metadata=None):
        self.url = url
        self.root = root
        self.loop = loop
        self.metadata = metadata
        
        # formatter = YAMLPathFormatter('%Y-%m-%d/%H/{seq}.{ext}', '', '%Y-%m-%d/%H', ext=ext)
        # segments_list = SegmentsListYAMLStorage(root, formatter)
        self.storage = YAMLSegmentsStorage(
            root, chunk_notifier=chunk_notifier, chunk_size=chunk_size, ext=ext,
            parallel_downloads=parallel_downloads, loop=loop, metadata=metadata)
        
        self.default_sleep = 5
        self.sleeping = set()

        self._stop = False

    @property
    def stop(self):
        return self._stop

    @stop.setter
    def stop(self, value):
        self._stop = value
        self.storage.stop = value
        while self.sleeping:
            fut = self.sleeping.pop()
            fut.cancel()

    async def sleep(self, duration=None, loop=None):
        if not duration:
            duration = self.default_sleep
        sleep_future = asyncio.ensure_future(asyncio.sleep(duration, loop=loop), loop=loop)
        self.sleeping.add(sleep_future)
        await sleep_future
        if sleep_future in self.sleeping:
            self.sleeping.remove(sleep_future)

    # download with retry when disconnected
    async def download(self, url):
        error_sleep = 5
        # for i in range(4):
        while not self.stop:
            try:
                return await download(url)
            except (ClientOSError, ClientResponseError, ServerDisconnectedError,
                    concurrent.futures.TimeoutError) as e:
                if self.stop:
                    return
                logger.info('Network error: %s. Will retry in %d seconds'%(str(e), error_sleep))
                await asyncio.sleep(error_sleep, loop=None)
                if error_sleep < 60:
                    error_sleep *= 2    # 10s, 20s, 40s, 1m20s
            # except KeyboardInterrupt:
            #     print('downloader keyboard interrupt')
            #     raise

    async def wait(self):
        if self.storage.scheduler:
            logger.info('Waiting for downloaders to complete.')
            await self.storage.scheduler.wait()
        self.storage.list.close()

    async def __call__(self, run_forever=False):
        base = self.url.rsplit('/',1)[0]+'/'
        response = await download(self.url)
        if response.status != 200:
            # raise Exception('HTTP Error: %s' % response.status)
            logger.warning("HTTP Error %s for URL %s"%(response.status, self.url))
            return
        index = HLSIndex.parse(response.content, base)
        if not index.segments or not index.segments.first_segment:
            return

        if self.storage.list.last_segment:
            popped = index.segments.trimleft(self.storage.list.last_segment)
            # if popped == 0 and type(index.segments[0]) is not HLSSourceDiscontinuity:
            if popped == 0 and not isinstance(index.segments[0], HLSSourceDiscontinuity) and \
                    not (type(index.segments[0]) is type and issubclass(index.segments[0], HLSSourceDiscontinuity)):
                if not item_type(self.storage.list.last_item, (HLSPullDiscontinuity, HLSEnd)):
                    index.segments.appendleft(HLSPullDiscontinuity)
            else:
                self.storage.list.resume()

        if not index.complete and index.segments.first_segment and index.segments.first_segment.datetime is None:
            response, end_datetime = await self.detect_change(self.url, index.duration)
            latest_index = HLSIndex.parse(response.content, base)
            latest_index.segments.extendleft(index.segments).apply_end_datetime(end_datetime)
            index = latest_index

        segments = index.segments

        while segments:
            item = segments.popleft()
            self.storage.store(item)

        # calculate sleep duration between updates
        self.default_sleep = index.duration/2 or (index.last.duration/2 if index.last else 5)
        # default: half of default target duration: 5s

        prev_index = index
 
        live_updates = not index.complete
        # possible with BBC live stream: end list and continue after few moments
        # live_updates = True
        if run_forever:
            live_updates = True

        while live_updates and not self.stop:
            # await asyncio.sleep(self.sleep, loop=None)
            await self.sleep()  # cancellable sleep
            if self.stop:
                break
            try:
                # print('>>> Refresh index...')
                response = await self.download(self.url)
                if not response or response.status != 200:
                    raise Exception("HTTP Error %s for URL %s" % (response.status, self.url))
                index = HLSIndex.parse(response.content, base)
                if index.sequence < prev_index.sequence or segments.extend(index.segments) is None:
                    logger.info("Discontinuity for URL %s"%self.url)
                    if not item_type(segments.last_item or segments.last_removed_item,
                                     (HLSSourceEnd, HLSDiscontinuity)):
                        segments.appendleft(HLSSourceDiscontinuity)
                    response, end_datetime = await self.detect_change(self.url, index.duration)
                    latest_index = HLSIndex.parse(response.content, base)
                    latest_index.segments.extendleft(index.segments).apply_end_datetime(end_datetime)
                    prev_index = index
                    index = latest_index
                    segments.extend(index.segments, True)
                while segments:
                    item = segments.popleft()
                    self.storage.store(item)
                if not run_forever:
                    live_updates = not index.complete
            except Exception as e:
                if not run_forever:
                    raise
            # index.print()
            # for s in segments:
            #     print(s)
        # if index.complete and not self.stop:
        #     self.storage.store(HLSSourceEnd)         # write end tag string, must be already there by index parser
            # self.write(HLSEnd)
        # wait for downloads to complete
        await self.wait()

    @staticmethod
    async def detect_change(url, target_duration=None, sleep=0.3, count=None):

        def parse_datetime(datetime_string, default=None):
            if datetime_string:
                for fmt in ['%a, %d %b %Y %H:%M:%S %Z']:
                    try:
                        return datetime.strptime(datetime_string, fmt)
                    except ValueError:
                        pass
            return default

        print('Guessing live stream date-time from server time ...')
        first = await download(url)
        if first.status != 200:
            raise Exception("HTTP Error %s for URL %s" % (first.status, self.url))
        if count is None:
            count = (target_duration or 10) * 3 / sleep  # wait for max 3 segment durations to detect change in live stream index
        second = first
        while count > 0:
            await asyncio.sleep(sleep)
            second = await download(url)
            if second.status != 200:
                raise Exception("HTTP Error %s for URL %s" % (second.status, self.url))
            if first.content != second.content:
                break
            first = second
            count -= 1
        if first.content == second.content:
            # no content change detected
            raise ValueError('unable to detect change')
        first_dt = parse_datetime(first.headers.get('DATE'), datetime.utcnow())
        second_dt = parse_datetime(second.headers.get('DATE'), datetime.utcnow())
        end_datetime = second_dt - timedelta(seconds=(second_dt-first_dt).seconds/2)    # half between
        logger.info('Using server time for live stream date-time annotation '+
                    'with accuracy +/- %d seconds'%sleep)
        return second, end_datetime


def run_pull(pull, loop=None, run_forever=True):
    if loop is None:
        loop = asyncio.get_event_loop()
    try:
        loop.run_until_complete(pull(run_forever))
    except KeyboardInterrupt:
        # how to correctly handle loop interruption
        # http://stackoverflow.com/a/30766124
        pull.stop = True
        logger.warn('Received keyboard interrupt')
        # loop.run_forever()
        loop.run_until_complete(pull.wait())
        logger.info('Stopped pulling feeds!')
    # finally:
    #     loop.close()




if __name__ == "__main__":

    from argparse import ArgumentParser, ArgumentDefaultsHelpFormatter
    
    parser = ArgumentParser(description='HLS Stream Pull',
                            formatter_class=ArgumentDefaultsHelpFormatter)
    # parser.add_argument('--audio-only', action='store_true', help='use audio only stream')
    parser.add_argument('path', type=str,
                        help='target directory where downloaded stream will be stored')
    parser.add_argument('url', type=str,
                        help='source HLS stream M3U8 index URL')
    parser.add_argument('--parallel-downloads', '-j', type=int, default=1, metavar="<number>",
                        help='number of parallel downloads')

    args = parser.parse_args()

    pull = HLSPull(args.url, args.path)

    run_pull(pull)
