#!/usr/bin/env python3

from io import IOBase


def tail_lines(filename_or_file, line_count, seek=None, skip_last_newline=True, blocksize=4096):
    if type(filename_or_file) is str:
        f = open(filename_or_file, 'rb')
        if seek is None:
            seek = -1
    elif isinstance(filename_or_file, IOBase):
        f = filename_or_file
    else:
        return
    if type(blocksize) is not int or blocksize < 1:
        # blocksize = 1024      # 1KB
        blocksize = 4096        # 4KB
    # blocksize = 1024
    if seek is not None:
        if seek == -1:
            f.seek(0, 2)        # seek to eof
        else:
            f.seek(seek)
    left = f.tell()
    if line_count < 0:
        f.seek(0)
        result = f.read(left)
    else:
        chunks = []
        n = 0
        while n < line_count and left > 0:
            f.seek(max(0, left-blocksize))          # step back
            block = f.read(min(blocksize, left))
            if type(block) is not bytes:
                raise ValueError('file must be open in binary mode')
            last = len(block)
            if skip_last_newline and not chunks and block[-1] == b'\n'[0]: # newline at eof
                last -= 1
            while n < line_count and last > 0:
                last = block.rfind(b'\n', 0, last)
                if last != -1:
                    n += 1
            chunks.append(block if n < line_count and chunks else block[last+1:])
            # left -= len(block)
            left -= len(block) if n < line_count else len(block)-last
        result = b''.join(reversed(chunks))
    if f is not filename_or_file:
        f.close()
    else:
        f.seek(left)
    return result
    # skip last newline
    # return result[:-1] if skip_last_newline and result and result[-1] == b'\n'[0] else result

def tail_lines_backwards_yield(f, initial_lines=100, chunk_lines=100, max_lines=None, seek=-1):
    if max_lines == 0 or max_lines == -1:
        max_lines = None
    count = 0
    lines = tail_lines(f, initial_lines, seek=seek).decode('utf8').splitlines()
    while lines:
        for line in reversed(lines):
            count += 1
            yield line
            if type(max_lines) is not None and count >= max_lines:
                return
        lines = tail_lines(f, chunk_lines).decode('utf8').split('\n')


if __name__ == "__main__":

    import sys

    if len(sys.argv) == 1:
        print('usage: %s [filename] [number of lines to tail]' % sys.argv[0])
        sys.exit(0)

    # reversed
    # with open(sys.argv[1], 'rb') as f:
    #     for line in tail_lines_backwards_yield(f, max_lines=int(sys.argv[2]), initial_lines=2, chunk_lines=2):
    #         print(line)
    # sys.exit(0)

    lines = tail_lines(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 10)

    print(lines.decode('utf8'), end='', flush=True)
