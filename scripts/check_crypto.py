import ast
import json
import os
import re
import sys
import tomllib
from collections.abc import Iterator
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIPPED_DIRS = {".git", ".venv", "node_modules", "dist", "__pycache__", ".minibrain", ".pytest_cache", ".ruff_cache"}
WEB_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}

NON_APPROVED_HASHES = {"md4", "md5", "md5sha1", "sha", "sha1", "ripemd160", "blake2b", "blake2s", "sm3", "whirlpool"}
HASH_CONSTRUCTORS = {"hashlib.md5", "hashlib.sha1", "hashlib.blake2b", "hashlib.blake2s"}
SIGNING_DIGEST = "sha256"
HMAC_DIGEST_ARGUMENT = {"hmac.new": "digestmod", "hmac.HMAC": "digestmod", "hmac.digest": "digest"}
NON_APPROVED_PRIMITIVES = {
    "cryptography.hazmat.primitives.hashes.MD5",
    "cryptography.hazmat.primitives.hashes.SHA1",
    "cryptography.hazmat.primitives.hashes.BLAKE2b",
    "cryptography.hazmat.primitives.hashes.BLAKE2s",
    "cryptography.hazmat.primitives.hashes.SM3",
    "cryptography.hazmat.primitives.ciphers.algorithms.ChaCha20",
    "cryptography.hazmat.primitives.ciphers.algorithms.Camellia",
    "cryptography.hazmat.primitives.ciphers.algorithms.SM4",
    "cryptography.hazmat.primitives.ciphers.aead.ChaCha20Poly1305",
}
DECREPIT = "cryptography.hazmat.decrepit"
NON_FIPS_MODULES = {
    "Crypto",
    "Cryptodome",
    "argon2",
    "bcrypt",
    "blake3",
    "ecdsa",
    "ed25519",
    "libnacl",
    "nacl",
    "passlib",
    "pure25519",
    "pyaes",
    "pysodium",
    "rsa",
    "scrypt",
    "tinyec",
}
NON_FIPS_PYTHON_PACKAGES = {
    "argon2-cffi",
    "argon2-cffi-bindings",
    "bcrypt",
    "blake3",
    "ecdsa",
    "ed25519",
    "libnacl",
    "passlib",
    "pure25519",
    "pyaes",
    "pycrypto",
    "pycryptodome",
    "pycryptodomex",
    "pynacl",
    "pysodium",
    "rsa",
    "scrypt",
    "tinyec",
}
NON_FIPS_WEB_PACKAGES = {
    "@noble/ciphers",
    "@noble/curves",
    "@noble/hashes",
    "bcryptjs",
    "blueimp-md5",
    "create-hash",
    "crypto-js",
    "elliptic",
    "hash-wasm",
    "hash.js",
    "js-md5",
    "js-sha1",
    "jssha",
    "libsodium-wrappers",
    "libsodium-wrappers-sumo",
    "md5",
    "md5.js",
    "node-forge",
    "sha.js",
    "sha1",
    "sjcl",
    "spark-md5",
    "ts-md5",
    "tweetnacl",
    "tweetnacl-util",
}
SECRET_WORDS = {"secret", "password", "passwd", "nonce", "salt", "csrf", "otp", "credential", "credentials"}
SECRET_PAIRS = {("api", "key"), ("private", "key"), ("signing", "key"), ("session", "id")}

WEAK_WEB_LITERAL = re.compile(r"""["'`](sha-?1|md[45]|ripemd-?160)["'`]""", re.IGNORECASE)
WEB_IMPORT = re.compile(r"""(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*["']([^"'./][^"']*)["']""")
LOCK_PACKAGE = re.compile(r"^  '?/?((?:@[^/\s']+/)?[^@\s'/]+)@", re.MULTILINE)


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    rule: str
    message: str

    def render(self, root: Path) -> str:
        shown = self.path.relative_to(root) if self.path.is_relative_to(root) else self.path
        return f"{shown}:{self.line}: {self.rule}: {self.message}"


def normalized_hash(name: str) -> str:
    return re.sub(r"[-_]", "", name.lower())


def words(name: str) -> list[str]:
    return [part for part in re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name).lower().split("_") if part]


def secret_like(name: str) -> bool:
    parts = words(name)
    if not parts:
        return False
    return parts[-1] == "token" or bool(SECRET_WORDS & set(parts)) or bool(SECRET_PAIRS & set(pairwise(parts)))


def imported_names(tree: ast.AST) -> dict[str, str]:
    names: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                names[alias.asname or top] = alias.name if alias.asname else top
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            for alias in node.names:
                names[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return names


def qualified(node: ast.expr, names: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return names.get(node.id)
    if isinstance(node, ast.Attribute):
        base = qualified(node.value, names)
        return f"{base}.{node.attr}" if base else None
    return None


def argument(call: ast.Call, position: int, keyword: str) -> ast.expr | None:
    if len(call.args) > position:
        return call.args[position]
    return next((item.value for item in call.keywords if item.arg == keyword), None)


def not_for_security(call: ast.Call) -> bool:
    return any(
        item.arg == "usedforsecurity" and isinstance(item.value, ast.Constant) and item.value.value is False
        for item in call.keywords
    )


def digest_name(node: ast.expr | None, names: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return normalized_hash(node.value)
    found = qualified(node, names) if node is not None else None
    if found and found.startswith("hashlib."):
        return normalized_hash(found.removeprefix("hashlib."))
    return None


def imported_modules(node: ast.Import | ast.ImportFrom) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if not node.module or node.level:
        return []
    if node.module.split(".")[0] in NON_FIPS_MODULES or node.module.startswith(DECREPIT):
        return [node.module]
    return [f"{node.module}.{alias.name}" for alias in node.names]


def import_violations(path: Path, tree: ast.AST) -> Iterator[Violation]:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Import | ast.ImportFrom):
            continue
        for module in imported_modules(node):
            if module.split(".")[0] in NON_FIPS_MODULES:
                yield Violation(path, node.lineno, "non-fips-library", f"{module} is not OpenSSL or cryptography")
            elif module.startswith(DECREPIT) or module in NON_APPROVED_PRIMITIVES:
                yield Violation(path, node.lineno, "non-approved-primitive", f"{module} is not FIPS-approved")


def hash_call_violation(path: Path, call: ast.Call, name: str, names: dict[str, str]) -> Violation | None:
    line = call.lineno
    if name in HASH_CONSTRUCTORS and not not_for_security(call):
        return Violation(path, line, "weak-hash", f"{name} needs usedforsecurity=False; use SHA-256 for security")
    if name == "hashlib.new":
        algorithm = digest_name(argument(call, 0, "name"), names)
        if algorithm in NON_APPROVED_HASHES and not not_for_security(call):
            return Violation(path, line, "weak-hash", f"hashlib.new({algorithm}) needs usedforsecurity=False")
    if name == "hashlib.file_digest" and digest_name(argument(call, 1, "digest"), names) in NON_APPROVED_HASHES:
        return Violation(path, line, "weak-hash", "hashlib.file_digest with a non-approved hash; use SHA-256")
    if name == "hashlib.scrypt":
        return Violation(path, line, "non-approved-kdf", "scrypt is not FIPS-approved; use PBKDF2-HMAC-SHA256")
    if name == "hashlib.pbkdf2_hmac" and digest_name(argument(call, 0, "hash_name"), names) != SIGNING_DIGEST:
        return Violation(path, line, "non-approved-kdf", "pbkdf2_hmac must use SHA-256")
    if name in HMAC_DIGEST_ARGUMENT:
        digest = digest_name(argument(call, 2, HMAC_DIGEST_ARGUMENT[name]), names)
        if digest != SIGNING_DIGEST:
            return Violation(path, line, "weak-hmac", f"{name} uses {digest or 'an unchecked digest'}; use SHA-256")
    return None


def call_violations(path: Path, tree: ast.AST, names: dict[str, str]) -> Iterator[Violation]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and (name := qualified(node.func, names)):
            found = hash_call_violation(path, node, name, names)
            if found:
                yield found
        elif isinstance(node, ast.Attribute) and (name := qualified(node, names)):
            if name in NON_APPROVED_PRIMITIVES or name.startswith(DECREPIT):
                yield Violation(path, node.lineno, "non-approved-primitive", f"{name} is not FIPS-approved")


def target_names(node: ast.expr) -> Iterator[str]:
    if isinstance(node, ast.Name):
        yield node.id
    elif isinstance(node, ast.Attribute):
        yield node.attr
    elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
        yield node.slice.value
    elif isinstance(node, ast.Starred):
        yield from target_names(node.value)
    elif isinstance(node, ast.Tuple | ast.List):
        for element in node.elts:
            yield from target_names(element)


def secret_scopes(node: ast.AST) -> Iterator[tuple[str, ast.AST]]:
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and secret_like(node.name):
        yield node.name, node
    elif isinstance(node, ast.Assign):
        for target in node.targets:
            yield from ((name, node.value) for name in target_names(target) if secret_like(name))
    elif isinstance(node, ast.AnnAssign | ast.AugAssign | ast.NamedExpr) and node.value is not None:
        yield from ((name, node.value) for name in target_names(node.target) if secret_like(name))
    elif isinstance(node, ast.keyword) and node.arg and secret_like(node.arg):
        yield node.arg, node.value
    elif isinstance(node, ast.Dict):
        for key, value in zip(node.keys, node.values, strict=True):
            if isinstance(key, ast.Constant) and isinstance(key.value, str) and secret_like(key.value):
                yield key.value, value


def from_random(name: str | None) -> bool:
    return name is not None and name.startswith("random.") and name != "random.SystemRandom"


def random_calls(scope: ast.AST, names: dict[str, str]) -> Iterator[ast.Call]:
    for node in ast.walk(scope):
        if isinstance(node, ast.Call) and from_random(qualified(node.func, names)):
            yield node


def random_violations(path: Path, tree: ast.AST, names: dict[str, str]) -> Iterator[Violation]:
    seen: set[tuple[int, int]] = set()
    for node in ast.walk(tree):
        for label, scope in secret_scopes(node):
            for call in random_calls(scope, names):
                if (call.lineno, call.col_offset) not in seen:
                    seen.add((call.lineno, call.col_offset))
                    yield Violation(path, call.lineno, "random-secret", f"{label} comes from random; use secrets")


def python_violations(path: Path, source: str) -> list[Violation]:
    tree = ast.parse(source, filename=str(path))
    names = imported_names(tree)
    found = [*import_violations(path, tree), *call_violations(path, tree, names), *random_violations(path, tree, names)]
    return sorted(set(found), key=lambda item: (item.line, item.rule))


def package_name(specifier: str) -> str:
    parts = specifier.split("/")
    return "/".join(parts[:2]) if specifier.startswith("@") else parts[0]


def line_of(source: str, offset: int) -> int:
    return source.count("\n", 0, max(offset, 0)) + 1


def web_violations(path: Path, source: str) -> list[Violation]:
    found = [
        Violation(path, line_of(source, match.start()), "weak-hash", f"{match.group(1)} in the web app; use SHA-256")
        for match in WEAK_WEB_LITERAL.finditer(source)
    ]
    found += [
        Violation(path, line_of(source, match.start()), "non-fips-library", f"{match.group(1)} is not Web Crypto")
        for match in WEB_IMPORT.finditer(source)
        if package_name(match.group(1)) in NON_FIPS_WEB_PACKAGES
    ]
    return sorted(found, key=lambda item: item.line)


def manifest_violations(path: Path, source: str) -> list[Violation]:
    manifest = json.loads(source)
    sections = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
    declared = {name for section in sections for name in manifest.get(section, {})}
    return [
        Violation(path, line_of(source, source.find(f'"{name}"')), "non-fips-dependency", f"{name} is a crypto library")
        for name in sorted(declared & NON_FIPS_WEB_PACKAGES)
    ]


def pnpm_lock_violations(path: Path, source: str) -> list[Violation]:
    found: dict[str, Violation] = {}
    for match in LOCK_PACKAGE.finditer(source):
        name = match.group(1)
        if name in NON_FIPS_WEB_PACKAGES and name not in found:
            found[name] = Violation(path, line_of(source, match.start()), "non-fips-dependency", f"{name} is locked")
    return list(found.values())


def uv_lock_violations(path: Path, source: str) -> list[Violation]:
    packages = tomllib.loads(source).get("package", [])
    names = sorted({re.sub(r"[-_.]+", "-", package["name"].lower()) for package in packages})
    return [
        Violation(path, line_of(source, source.find(f'name = "{name}"')), "non-fips-dependency", f"{name} is locked")
        for name in names
        if name in NON_FIPS_PYTHON_PACKAGES
    ]


def source_files(root: Path, suffixes: set[str], excluded: Path | None = None) -> Iterator[Path]:
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in SKIPPED_DIRS and Path(folder, name) != excluded)
        yield from (Path(folder, name) for name in sorted(files) if Path(name).suffix in suffixes)


def check(root: Path) -> list[Violation]:
    found: list[Violation] = []
    web = root / "web"
    for path in source_files(root, {".py"}, excluded=web):
        found += python_violations(path, path.read_text())
    for path in source_files(web, WEB_SUFFIXES) if web.is_dir() else ():
        found += web_violations(path, path.read_text())
    checks = [(root / "uv.lock", uv_lock_violations), (web / "package.json", manifest_violations)]
    checks.append((web / "pnpm-lock.yaml", pnpm_lock_violations))
    for path, scan in checks:
        if path.is_file():
            found += scan(path, path.read_text())
    return found


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else ROOT
    found = check(root)
    for violation in found:
        print(violation.render(root))
    print(f"{len(found)} crypto rule violations" if found else "Crypto rules passed")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
