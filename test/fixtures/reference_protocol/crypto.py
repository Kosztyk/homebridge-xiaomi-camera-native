"""MISS and Mi Cloud crypto, ported from AlexxIT/go2rtc (MIT; see NOTICE).

Use native cryptography primitives for X25519, ChaCha20 and RC4. HSalsa20 is
the small key-derivation transform required by NaCl box.Precompute; a bare
X25519 shared secret is NOT the MISS media key.
"""

from __future__ import annotations

import base64
import hashlib
import os
import struct
import time

from cryptography.hazmat.decrepit.ciphers.algorithms import ARC4
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms

from .errors import ProtocolError


def _rotate(value: int, count: int) -> int:
    return ((value << count) | (value >> (32 - count))) & 0xFFFFFFFF


def hsalsa20(key: bytes) -> bytes:
    """HSalsa20(key, sixteen zero bytes), as used by NaCl crypto_box_beforenm."""
    if len(key) != 32:
        raise ValueError("Expected a 32-byte key")
    constants = struct.unpack("<4I", b"expand 32-byte k")
    k = struct.unpack("<8I", key)
    x = [constants[0], *k[:4], constants[1], 0, 0, 0, 0, constants[2], *k[4:], constants[3]]

    def quarter(a: int, b: int, c: int, d: int) -> None:
        x[b] ^= _rotate((x[a] + x[d]) & 0xFFFFFFFF, 7)
        x[c] ^= _rotate((x[b] + x[a]) & 0xFFFFFFFF, 9)
        x[d] ^= _rotate((x[c] + x[b]) & 0xFFFFFFFF, 13)
        x[a] ^= _rotate((x[d] + x[c]) & 0xFFFFFFFF, 18)

    for _ in range(10):
        quarter(0, 4, 8, 12)
        quarter(5, 9, 13, 1)
        quarter(10, 14, 2, 6)
        quarter(15, 3, 7, 11)
        quarter(0, 1, 2, 3)
        quarter(5, 6, 7, 4)
        quarter(10, 11, 8, 9)
        quarter(15, 12, 13, 14)
    return struct.pack("<8I", *(x[i] for i in (0, 5, 10, 15, 6, 7, 8, 9)))


def generate_keypair() -> tuple[bytes, bytes]:
    """Return raw public and private keys."""
    private = X25519PrivateKey.generate()
    return (
        private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        ),
        private.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        ),
    )


def shared_key(device_public: bytes, client_private: bytes) -> bytes:
    try:
        secret = X25519PrivateKey.from_private_bytes(client_private).exchange(
            X25519PublicKey.from_public_bytes(device_public)
        )
        return hsalsa20(secret)
    except ValueError:
        raise ProtocolError("Invalid camera session key") from None


def chacha_xor(key: bytes, nonce: bytes, data: bytes, counter: int = 0) -> bytes:
    """IETF ChaCha20 with the MISS zero high nonce word and an 8-byte nonce.

    cryptography takes a 64-bit counter + 64-bit nonce. For a zero high nonce
    word this is byte-identical to Go's IETF cipher until 2**32 blocks.
    """
    if len(key) != 32 or len(nonce) != 8 or not 0 <= counter < 2**32:
        raise ProtocolError("Invalid camera cipher parameters")
    cipher = Cipher(algorithms.ChaCha20(key, struct.pack("<Q", counter) + nonce), mode=None)
    return cipher.encryptor().update(data)


def encode_media(key: bytes, data: bytes, nonce: bytes | None = None) -> bytes:
    nonce = os.urandom(8) if nonce is None else nonce
    return nonce + chacha_xor(key, nonce, data)


def decode_media(key: bytes, data: bytes) -> bytes:
    if len(data) < 8:
        raise ProtocolError("Encrypted camera packet is too short")
    return chacha_xor(key, data[:8], data[8:])


def rc4_drop1024(key: bytes, data: bytes) -> bytes:
    cipher = Cipher(ARC4(key), mode=None).encryptor()
    cipher.update(bytes(1024))
    return cipher.update(data)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def make_nonce() -> bytes:
    return os.urandom(8) + struct.pack(">I", int(time.time()) // 60)


def cloud_signature(path: str, values: dict[str, str], signed_nonce: bytes) -> str:
    parts = ["POST", path, f"data={values['data']}"]
    if "rc4_hash__" in values:
        parts.append(f"rc4_hash__={values['rc4_hash__']}")
    parts.append(b64(signed_nonce))
    return b64(hashlib.sha1("&".join(parts).encode()).digest())


def encrypt_cloud_request(
    security: bytes, path: str, data: str, nonce: bytes | None = None
) -> tuple[dict[str, str], bytes]:
    nonce = make_nonce() if nonce is None else nonce
    signed = hashlib.sha256(security + nonce).digest()
    values = {"data": data}
    values["rc4_hash__"] = cloud_signature(path, values, signed)
    values = {k: b64(rc4_drop1024(signed, v.encode())) for k, v in values.items()}
    values["signature"] = cloud_signature(path, values, signed)
    values["_nonce"] = b64(nonce)
    return values, signed
