#!/usr/bin/env python3
# https://www.rfc-editor.org/rfc/rfc8032.html#section-5.1
# Verification only: all curve operations below use public data.
import hashlib
import json
import re
import sys

FIELD = 2**255 - 19
ORDER = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, FIELD - 2, FIELD) % FIELD
SQRT_MINUS_ONE = pow(2, (FIELD - 1) // 4, FIELD)
IDENTITY = (0, 1, 1, 0)


def point_add(left, right):
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = (y1 - x1) * (y2 - x2) % FIELD
    b = (y1 + x1) * (y2 + x2) % FIELD
    c = 2 * D * t1 * t2 % FIELD
    d = 2 * z1 * z2 % FIELD
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % FIELD, g * h % FIELD, f * g % FIELD, e * h % FIELD)


def point_mul(scalar, point):
    result = IDENTITY
    while scalar:
        if scalar & 1:
            result = point_add(result, point)
        point = point_add(point, point)
        scalar >>= 1
    return result


def point_equal(left, right):
    return ((left[0] * right[2] - right[0] * left[2]) % FIELD == 0
            and (left[1] * right[2] - right[1] * left[2]) % FIELD == 0)


def decode_point(encoded):
    if len(encoded) != 32:
        raise ValueError("Ed25519 point must contain 32 bytes")
    packed = int.from_bytes(encoded, "little")
    y, sign = packed & (2**255 - 1), packed >> 255
    if y >= FIELD:
        raise ValueError("Noncanonical Ed25519 point")
    y_squared = y * y % FIELD
    x_squared = (y_squared - 1) * pow(D * y_squared + 1, FIELD - 2, FIELD) % FIELD
    x = pow(x_squared, (FIELD + 3) // 8, FIELD)
    if (x * x - x_squared) % FIELD:
        x = x * SQRT_MINUS_ONE % FIELD
    if (x * x - x_squared) % FIELD or (x == 0 and sign):
        raise ValueError("Invalid Ed25519 point")
    if x & 1 != sign:
        x = FIELD - x
    return (x, y, 1, x * y % FIELD)


BASE = decode_point(bytes.fromhex("58" + "66" * 31))


def verify_ed25519(public_key, message, signature):
    if len(signature) != 64:
        raise ValueError("Ed25519 signature must contain 64 bytes")
    public = decode_point(public_key)
    r_point = decode_point(signature[:32])
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= ORDER:
        raise ValueError("Noncanonical Ed25519 scalar")
    # The installer accepts canonical points and the strict verification
    # equation. Reject small-order keys and R values, including the identity.
    if any(point_equal(point_mul(8, point), IDENTITY) for point in (public, r_point)):
        raise ValueError("Small-order Ed25519 point")
    challenge = int.from_bytes(
        hashlib.sha512(signature[:32] + public_key + message).digest(), "little"
    ) % ORDER
    if not point_equal(point_mul(scalar, BASE), point_add(r_point, point_mul(challenge, public))):
        raise ValueError("Ed25519 signature does not match")


def decode_did_key(did):
    if not isinstance(did, str) or not did.startswith("did:key:z"):
        raise ValueError("Expected an Ed25519 did:key with base58btc encoding")
    encoded = did[len("did:key:z"):]
    if not 1 <= len(encoded) <= 64:
        raise ValueError("Invalid DID key length")
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for char in encoded:
        number = number * 58 + alphabet.index(char)
    raw = (b"\0" * (len(encoded) - len(encoded.lstrip("1")))
           + number.to_bytes((number.bit_length() + 7) // 8, "big"))
    if len(raw) != 34 or raw[:2] != b"\xed\x01":
        raise ValueError("DID key must use the Ed25519 multicodec")
    return raw[2:]


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field: " + key)
        result[key] = value
    return result


def verify_envelope(json_file, domain, expected_did):
    with open(json_file, "r", encoding="utf-8") as source:
        envelope = json.load(source, object_pairs_hook=unique_object)
    signer = envelope["signer_did"]
    if not expected_did or signer != expected_did:
        raise ValueError("Envelope signer differs from the pinned maintainer DID")
    payload = envelope["payload"]
    if not isinstance(payload, dict):
        raise ValueError("Release payload must be a JSON object")
    if "signer_did" in payload and payload["signer_did"] != signer:
        raise ValueError("Payload and envelope signer differ")
    signature = envelope["signature"]
    if not isinstance(signature, str) or not re.fullmatch(r"[0-9a-fA-F]{128}", signature):
        raise ValueError("Signature must contain 64 hex-encoded bytes")
    # Matches the publisher's compact sorted UTF-8 JSON and Runtime's
    # SHA256(domain + NUL + payload), signed with ordinary Ed25519.
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True,
                           ensure_ascii=False, allow_nan=False).encode("utf-8")
    digest = hashlib.sha256(domain.encode("utf-8") + b"\0" + canonical).digest()
    verify_ed25519(decode_did_key(signer), digest, bytes.fromhex(signature))


def _varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def release_head_cid(data):
    """CIDv0 of a UnixFS file, matching Kubo's default ipfs add of release-head.json."""
    unixfs = bytes([0x08, 0x02]) + bytes([0x12]) + _varint(len(data)) + data + bytes([0x18]) + _varint(len(data))
    dag = bytes([0x0A]) + _varint(len(unixfs)) + unixfs
    digest = hashlib.sha256(dag).digest()
    number = int.from_bytes(b"\x12\x20" + digest, "big")
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    encoded = ""
    while number:
        number, digit = divmod(number, 58)
        encoded = alphabet[digit] + encoded
    return encoded


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--cid":
            print(release_head_cid(open(sys.argv[2], "rb").read()))
        else:
            verify_envelope(*sys.argv[1:])
    except (ValueError, TypeError, KeyError, OSError, AttributeError) as error:
        print("Signature verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)