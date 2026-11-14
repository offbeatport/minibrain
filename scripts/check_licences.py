import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ECOSYSTEMS = ["python", "web"]
PYPI = "https://pypi.org/pypi/{name}/{version}/json"

ALLOWED = frozenset(
    {
        "0BSD",
        "AFL-2.1",
        "Apache-2.0",
        "BlueOak-1.0.0",
        "BSD",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "BSL-1.0",
        "CC-BY-4.0",
        "CC0-1.0",
        "CNRI-Python",
        "HPND",
        "ISC",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
        "MIT",
        "MIT-0",
        "MIT-CMU",
        "MPL-2.0",
        "OFL-1.1",
        "PSF-2.0",
        "Python-2.0",
        "Unicode-3.0",
        "Unlicense",
        "Zlib",
    }
)

ALLOWED_EXCEPTIONS = frozenset({"LLVM-exception"})

ALIASES = {
    "3-clause bsd license": "BSD-3-Clause",
    "apache 2.0 license": "Apache-2.0",
    "apache 2.0": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "apache": "Apache-2.0",
    "apache2": "Apache-2.0",
    "bsd license": "BSD",
    "bsd-3": "BSD-3-Clause",
    "bsd 3-clause": "BSD-3-Clause",
    "cc0 1.0": "CC0-1.0",
    "cc0 1.0 or mit": "CC0-1.0 OR MIT",
    "gnu lesser general public license v3 (lgplv3)": "LGPL-3.0-only",
    "historical permission notice and disclaimer (hpnd)": "HPND",
    "isc license (iscl)": "ISC",
    "mit license": "MIT",
    "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "new bsd": "BSD-3-Clause",
    "new bsd license": "BSD-3-Clause",
    "psf": "PSF-2.0",
    "python software foundation license": "PSF-2.0",
    "the unlicense (unlicense)": "Unlicense",
}

CLASSIFIER = re.compile(r"^License :: OSI Approved :: (?P<name>.+)$")

NVIDIA = "LicenseRef-NVIDIA-Software-License"
NVIDIA_REASON = "CUDA libraries torch pulls in on Linux; NVIDIA's licence lets an application redistribute them"

KNOWN = {
    "cuda-toolkit": NVIDIA,
    "fsspec": "BSD-3-Clause",
    "nvidia-": NVIDIA,
}

EXCEPTIONS = {
    "cuda-toolkit": (NVIDIA, NVIDIA_REASON),
    "nvidia-": (NVIDIA, NVIDIA_REASON),
    "pykcs11": (
        "GPL-2.0-or-later",
        "optional hsm extra the operator installs; never in the wheel's requirements or the image",
    ),
}


@dataclass(frozen=True)
class Package:
    ecosystem: str
    name: str
    version: str
    licence: str


def tokens(expression: str) -> list[str]:
    return re.findall(r"\(|\)|[^\s()]+", expression)


def allowed(expression: str) -> bool:
    found = tokens(expression)
    if not found:
        return False
    position = 0

    def peek() -> str | None:
        return found[position] if position < len(found) else None

    def take() -> str:
        nonlocal position
        position += 1
        return found[position - 1]

    def either() -> bool:
        result = both()
        while (peek() or "").upper() == "OR":
            take()
            result = both() or result
        return result

    def both() -> bool:
        result = single()
        while (peek() or "").upper() == "AND":
            take()
            result = single() and result
        return result

    def single() -> bool:
        part = take()
        if part == "(":
            result = either()
            if take() != ")":
                raise ValueError(expression)
            return result
        result = part.removesuffix("+") in ALLOWED
        if (peek() or "").upper() == "WITH":
            take()
            result = result and take() in ALLOWED_EXCEPTIONS
        return result

    try:
        result = either()
    except IndexError as error:
        raise ValueError(expression) from error
    if peek() is not None:
        raise ValueError(expression)
    return result


def known(name: str) -> str | None:
    return next((licence for prefix, licence in KNOWN.items() if name.startswith(prefix)), None)


def exception(package: Package) -> tuple[str, str] | None:
    return next(
        (
            accepted
            for prefix, accepted in EXCEPTIONS.items()
            if package.name.startswith(prefix) and accepted[0] == package.licence
        ),
        None,
    )


def normalised(text: str) -> str:
    cleaned = text.strip()
    return ALIASES.get(cleaned.lower(), cleaned)


def pypi_licence(info: dict[str, Any]) -> str:
    expression = (info.get("license_expression") or "").strip()
    if expression:
        return expression
    classified = [
        normalised(match["name"])
        for classifier in info.get("classifiers") or []
        if (match := CLASSIFIER.match(classifier))
    ]
    if classified:
        return " OR ".join(dict.fromkeys(classified))
    text = (info.get("license") or "").strip()
    if text and "\n" not in text and len(text) <= 80:
        return normalised(text)
    return ""


def fetch_json(url: str, attempts: int = 3) -> dict[str, Any]:
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError):
            if attempt == attempts - 1:
                raise
            time.sleep(2**attempt)
    raise RuntimeError(url)


def python_pins() -> list[tuple[str, str]]:
    command = [
        "uv",
        "export",
        "--frozen",
        "--no-dev",
        "--all-extras",
        "--no-hashes",
        "--no-emit-project",
        "--no-header",
        "--no-annotate",
        "--format",
        "requirements-txt",
    ]
    output = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True).stdout
    pins = []
    for line in output.splitlines():
        requirement = line.split(";")[0].strip()
        if "==" in requirement:
            name, version = requirement.split("==", 1)
            pins.append((name.split("[")[0].strip().lower(), version.strip()))
    return sorted(set(pins))


def python_package(pin: tuple[str, str], lookup: Callable[[str], dict[str, Any]]) -> Package:
    name, version = pin
    licence = known(name) or pypi_licence(lookup(PYPI.format(name=name, version=version))["info"])
    return Package("python", name, version, licence)


def python_packages(lookup: Callable[[str], dict[str, Any]] = fetch_json) -> list[Package]:
    with ThreadPoolExecutor(max_workers=16) as pool:
        return list(pool.map(lambda pin: python_package(pin, lookup), python_pins()))


def pnpm_listing() -> dict[str, list[dict[str, Any]]]:
    command = ["pnpm", "licenses", "list", "--json", "--prod"]
    return json.loads(subprocess.run(command, cwd=ROOT / "web", check=True, capture_output=True, text=True).stdout)


def web_packages(listing: dict[str, list[dict[str, Any]]]) -> list[Package]:
    return [
        Package("web", entry["name"], version, normalised(licence))
        for licence, entries in listing.items()
        for entry in entries
        for version in entry.get("versions") or [""]
    ]


def problems(packages: Iterable[Package]) -> list[str]:
    found = []
    for package in packages:
        label = f"{package.ecosystem} {package.name} {package.version}"
        if not package.licence:
            found.append(f"{label}: no licence in its metadata; add it to KNOWN after checking by hand")
            continue
        try:
            if allowed(package.licence) or exception(package):
                continue
        except ValueError:
            found.append(f"{label}: cannot read the licence expression {package.licence!r}")
            continue
        found.append(f"{label}: {package.licence} is outside the policy")
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check dependency licences against the Apache-2.0 policy")
    parser.add_argument("ecosystems", nargs="*", choices=ECOSYSTEMS)
    parser.add_argument("--list", action="store_true", help="print every package with its licence")
    args = parser.parse_args(argv)
    ecosystems = args.ecosystems or ECOSYSTEMS
    packages: list[Package] = []
    if "python" in ecosystems:
        packages += python_packages()
    if "web" in ecosystems:
        packages += web_packages(pnpm_listing())
    if args.list:
        for package in sorted(packages, key=lambda found: (found.ecosystem, found.name)):
            print(f"{package.ecosystem}\t{package.name}\t{package.version}\t{package.licence}")
    found = problems(packages)
    for line in found:
        print(line, file=sys.stderr)
    accepted: dict[tuple[str, str], list[str]] = {}
    for package in packages:
        if (found_exception := exception(package)) is not None:
            accepted.setdefault(found_exception, []).append(package.name)
    for (licence, reason), names in accepted.items():
        print(f"accepted {licence} for {', '.join(sorted(names))}: {reason}")
    if found:
        return 1
    print(f"{len(packages)} dependency licences fit the policy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
