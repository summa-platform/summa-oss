#!/usr/bin/env python3

import sys, json

# must be installed
from aiohttp import web

# monkey patch: https://github.com/KeepSafe/aiohttp/issues/860
from aiohttp.web_reqrep import StreamResponse
StreamResponse.set_tcp_nodelay = lambda self, value: None

import aiohttp_cors


async def request_dumper(request):
    try:
        print('Request:', request)
        print('Match info:', ','.join('%s=%s' % item for item in request.match_info.items()))
        print('Query string:', request.query_string)
        print('Headers:')
        for header,value in request.headers.items():
            print('  %s: %s' % (header, value))
        print('BODY:')
        # content = await request.read()
        content = await request.content.read()
        print(json.dumps(json.loads(content.decode('utf8')), indent=4))
        print('---')
        content_type = 'application/json'
        return web.Response(body=b'', content_type=content_type)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        raise web.HTTPNotFound
    except Exception as e:
        print(e, file=sys.stderr)
        raise web.HTTPInternalServerError

def test_endpoint(endpoint='/new_chunk', host='0.0.0.0', port=6010):
    app = web.Application()
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
                allow_credentials=True,
                expose_headers="*",
                allow_headers="*",
            )
    })
    cors.add(app.router.add_resource(endpoint).add_route('POST', request_dumper))
    web.run_app(app, host=host, port=port)


if __name__ == "__main__":

    import argparse

    parser = argparse.ArgumentParser(description='HLS Chunk Submission Test Endpoint', formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument('--host', type=str, default='0.0.0.0', help='host for HTTP server')
    parser.add_argument('--port', type=int, default=6010, help='port for HTTP server')
    parser.add_argument('--endpoint', type=str, default='/new_chunk', help='endpoint path for POST submissions')

    args = parser.parse_args()

    test_endpoint(args.endpoint, args.host, args.port)
