import json
from pathlib import Path

from scripts.check_crypto import ROOT, Violation, check, python_violations, secret_like, web_violations


def rules(source: str) -> list[tuple[int, str]]:
    return [(found.line, found.rule) for found in python_violations(Path("sample.py"), source)]


def web_rules(source: str) -> list[tuple[int, str]]:
    return [(found.line, found.rule) for found in web_violations(Path("sample.ts"), source)]


def test_the_repository_follows_the_crypto_rules() -> None:
    assert [found.render(ROOT) for found in check(ROOT)] == []


def test_md5_and_sha1_need_usedforsecurity_false() -> None:
    source = """
import hashlib
from hashlib import sha1 as quick
hashlib.md5(b"x")
quick(b"x")
hashlib.new("SHA1", b"x")
hashlib.new("md5", usedforsecurity=False)
hashlib.sha1(b"x", usedforsecurity=False)
hashlib.file_digest(handle, "md5")
hashlib.sha256(b"x")
hashlib.new("sha256")
"""
    assert rules(source) == [(4, "weak-hash"), (5, "weak-hash"), (6, "weak-hash"), (9, "weak-hash")]


def test_kdfs_must_be_pbkdf2_with_sha256() -> None:
    source = """
import hashlib
hashlib.scrypt(b"pw", salt=b"s", n=2, r=8, p=1)
hashlib.pbkdf2_hmac("sha1", b"pw", b"s", 1000)
hashlib.pbkdf2_hmac("sha256", b"pw", b"s", 1000)
"""
    assert rules(source) == [(3, "non-approved-kdf"), (4, "non-approved-kdf")]


def test_hmac_must_use_sha256() -> None:
    source = """
import hashlib
import hmac
hmac.new(key, msg, hashlib.md5)
hmac.new(key, msg, digestmod="sha1")
hmac.digest(key, msg, algorithm)
hmac.new(key, msg)
hmac.new(key, msg, hashlib.sha256)
hmac.HMAC(key, msg, digestmod="SHA256")
hmac.digest(key, msg, digest="sha256")
hmac.compare_digest(a, b)
"""
    assert rules(source) == [(4, "weak-hmac"), (5, "weak-hmac"), (6, "weak-hmac"), (7, "weak-hmac")]


def test_crypto_outside_openssl_and_cryptography_is_refused() -> None:
    source = """
from Crypto.Cipher import AES
import nacl.secret
import bcrypt
from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
hashes.SHA1()
hashes.SHA256()
AESGCM(key)
"""
    assert rules(source) == [
        (2, "non-fips-library"),
        (3, "non-fips-library"),
        (4, "non-fips-library"),
        (5, "non-approved-primitive"),
        (7, "non-approved-primitive"),
        (8, "non-approved-primitive"),
    ]


def test_random_is_refused_for_tokens_and_secrets() -> None:
    source = """
import random
from random import choice
token = "".join(choice(ALPHABET) for _ in range(32))
settings.api_key = random.randbytes(16).hex()
headers = {"csrf": random.getrandbits(64)}
issue(password=random.random())

def new_session_token() -> str:
    return str(random.Random().random())

delay = random.random()
random.Random(seed).shuffle(rows)
prompt_tokens = random.randint(1, 10)
secret = random.SystemRandom().random()
"""
    assert rules(source) == [(line, "random-secret") for line in (4, 5, 6, 7, 10)]


def test_secret_names_are_split_into_words() -> None:
    assert all(secret_like(name) for name in ("token", "gatewayToken", "API_KEY", "salt_bytes", "session_id"))
    assert not any(secret_like(name) for name in ("max_tokens", "token_ids", "footprint", "monkey", "keys"))


def test_web_code_uses_web_crypto_with_sha256() -> None:
    source = """import md5 from "blueimp-md5";
import { sha256 } from "@noble/hashes/sha256";
import { helper } from "./md5";
const legacy = await crypto.subtle.digest("SHA-1", data);
const digest = await crypto.subtle.digest("SHA-256", data);
const lib = require("crypto-js/md5");
"""
    expected = [(1, "non-fips-library"), (2, "non-fips-library"), (4, "weak-hash"), (6, "non-fips-library")]
    assert web_rules(source) == expected


def test_locked_dependencies_are_checked(tmp_path: Path) -> None:
    packages = [f'[[package]]\nname = "{name}"\nversion = "1"\n' for name in ("httpx", "pycryptodome")]
    (tmp_path / "uv.lock").write_text("version = 1\n\n" + "\n".join(packages))
    web = tmp_path / "web"
    (web / "src").mkdir(parents=True)
    (web / "package.json").write_text(json.dumps({"dependencies": {"react": "19", "crypto-js": "4"}}, indent=4))
    (web / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n\npackages:\n\n  tweetnacl@1.0.3:\n    version: 1\n")
    (web / "src" / "app.ts").write_text('const hash = "md5";\n')
    (web / "node_modules" / "md5").mkdir(parents=True)
    (web / "node_modules" / "md5" / "index.js").write_text('module.exports = "md5";\n')
    (tmp_path / "tool.py").write_text("import hashlib\nhashlib.md5(b'x')\n")
    found = {(found.path.relative_to(tmp_path).as_posix(), found.line, found.rule) for found in check(tmp_path)}
    assert found == {
        ("tool.py", 2, "weak-hash"),
        ("uv.lock", 8, "non-fips-dependency"),
        ("web/package.json", 4, "non-fips-dependency"),
        ("web/pnpm-lock.yaml", 5, "non-fips-dependency"),
        ("web/src/app.ts", 1, "weak-hash"),
    }


def test_violations_render_relative_to_the_root(tmp_path: Path) -> None:
    found = Violation(tmp_path / "minibrain" / "x.py", 3, "weak-hash", "hashlib.md5 needs usedforsecurity=False")
    assert found.render(tmp_path) == "minibrain/x.py:3: weak-hash: hashlib.md5 needs usedforsecurity=False"
