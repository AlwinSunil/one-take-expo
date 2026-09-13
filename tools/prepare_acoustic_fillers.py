#!/usr/bin/env python3
"""Stage the optional development-only Uhm model; never writes release assets."""
import hashlib
from pathlib import Path
import tempfile
import ssl
import urllib.request

REVISION = '612592c10ad7b2a51f3237725448a1aad212480b'
MODEL = 'uhm-web-fp16.onnx'
SHA256 = 'c266faf7db4cdced6f18aa9119ff2800a20707d7159be645d487ec191a9d79ff'
SIZE = 47047128
DESTINATION = Path(__file__).resolve().parent / '.cache/acoustic-fillers/assets'


def ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def stage():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    target = DESTINATION / MODEL
    if not (target.exists() and target.stat().st_size == SIZE and hashlib.sha256(target.read_bytes()).hexdigest() == SHA256):
        url = f'https://huggingface.co/desert-ant-labs/uhm/resolve/{REVISION}/{MODEL}'
        temporary = None
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'one-take-build/1'}), timeout=120, context=ssl_context()) as response, tempfile.NamedTemporaryFile(dir=DESTINATION, delete=False) as output:
                temporary = Path(output.name)
                digest = hashlib.sha256()
                size = 0
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > SIZE:
                        raise ValueError('Model exceeds its pinned size.')
                    digest.update(block)
                    output.write(block)
            if size != SIZE or digest.hexdigest() != SHA256:
                raise ValueError('Model checksum does not match the pinned revision.')
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    with urllib.request.urlopen(urllib.request.Request('https://license.desertant.com/1.0.txt', headers={'User-Agent': 'Mozilla/5.0'}), timeout=30, context=ssl_context()) as response:
        license_text = response.read(1024 * 1024).decode('utf-8')
    (DESTINATION / 'DESERT-ANT-LICENSE.txt').write_text(license_text)
    (DESTINATION / 'DESERT-ANT-NOTICE.txt').write_text(
        'Powered by Desert Ant Labs\nhttps://desertant.com\n'
        f'Uhm revision {REVISION}\nModel SHA-256: {SHA256}\n'
        'Licensed under the Desert Ant Model License 1.0.\nhttps://license.desertant.com/1.0\n')
    print(f'Verified development model: {target}')


if __name__ == '__main__':
    stage()
