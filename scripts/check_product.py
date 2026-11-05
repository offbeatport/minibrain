import ast
import os
import re
import sys
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
INVENTORY = Path("docs/product.md")
AREAS = (
    "Data",
    "Models",
    "Training",
    "Evaluation",
    "Serving",
    "Improve",
    "Infrastructure",
    "Security",
    "Operations",
    "Settings",
    "Use cases",
)
USE_CASES = "Use cases"
STATUSES = ("shipped", "partial", "planned")
WHERE_KEYS = ("UI", "API", "CLI", "Config", "Policy", "Roadmap")
MAX_VALUE_WORDS = 12
PUBLIC_PREFIXES = ("/api/", "/v1/")

BULLET = re.compile(r"^- \*\*(?P<name>[^*]+)\*\* · (?P<status>\S+) · (?P<rest>.+)$")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


@dataclass(frozen=True)
class Surface:
    routes: frozenset[str]
    commands: frozenset[str]
    sections: frozenset[str]
    policies: frozenset[str]
    roadmap: frozenset[str]


@dataclass
class Feature:
    name: str
    status: str
    rest: str
    area: str
    line: int
    value: str = ""
    where: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class Inventory:
    users: list[str] = field(default_factory=list)
    areas: list[str] = field(default_factory=list)
    features: list[Feature] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def items(text: str) -> list[str]:
    return [item.strip() for item in text.split(",") if item.strip()]


def where_of(text: str) -> dict[str, list[str]] | None:
    found: dict[str, list[str]] = {}
    for part in text.split(" · "):
        key, colon, value = part.partition(": ")
        if not colon or key not in WHERE_KEYS or key in found:
            return None
        found[key] = [value.strip()] if key == "Roadmap" else items(value)
    return found


def detail(feature: Feature, text: str, number: int) -> str | None:
    where = where_of(text)
    if not feature.value and where is None:
        feature.value = text
    elif feature.value and not feature.where and where is not None:
        feature.where = where
    else:
        return f"{number}: {feature.name} takes one value line, then one where line"
    return None


def parse(text: str) -> Inventory:
    found = Inventory()
    current: Feature | None = None
    for number, line in enumerate(text.splitlines(), start=1):
        if line.startswith("Users: "):
            found.users = items(line.removeprefix("Users: "))
        elif line.startswith("## "):
            found.areas.append(line.removeprefix("## ").strip())
            current = None
        elif bullet := BULLET.match(line):
            area = found.areas[-1] if found.areas else ""
            current = Feature(bullet["name"].strip(), bullet["status"], bullet["rest"].strip(), area, number)
            found.features.append(current)
        elif line.startswith("  ") and line.strip() and current is not None:
            problem = detail(current, line.strip(), number)
            if problem:
                found.problems.append(problem)
        elif line.strip() and not line.startswith(("# ", "Principles: ")):
            found.problems.append(f"{number}: not a heading, feature, value or where line: {line.strip()}")
    return found


def known_command(entry: str, commands: frozenset[str]) -> bool:
    return any(entry == command or entry.startswith(f"{command} ") for command in commands)


def known_config(entry: str, sections: frozenset[str]) -> bool:
    return entry.split(".")[0] in sections or bool(ENV_NAME.match(entry))


def stale(feature: Feature, surface: Surface) -> Iterator[str]:
    checks = (
        ("API", lambda entry: entry in surface.routes, "no such route"),
        ("CLI", lambda entry: known_command(entry, surface.commands), "no such command"),
        ("Config", lambda entry: known_config(entry, surface.sections), "no such config section"),
        ("Policy", lambda entry: entry in surface.policies, "no such policy"),
    )
    for key, exists, reason in checks:
        for entry in feature.where.get(key, []):
            if not exists(entry):
                yield f"{feature.line}: {feature.name}: {key} {entry}: {reason}"


def feature_problems(feature: Feature, users: list[str], surface: Surface) -> Iterator[str]:
    where = f"{feature.line}: {feature.name}"
    if feature.status not in STATUSES:
        yield f"{where}: status {feature.status} is not one of {', '.join(STATUSES)}"
    unknown = [user for user in items(feature.rest) if user not in users]
    if unknown or not items(feature.rest):
        yield f"{where}: users {feature.rest} must come from the Users line"
    if not feature.value:
        yield f"{where}: needs a value line"
    elif len(feature.value.split()) > MAX_VALUE_WORDS:
        yield f"{where}: the value line has more than {MAX_VALUE_WORDS} words"
    roadmap = feature.where.get("Roadmap")
    if feature.status == "shipped" and roadmap:
        yield f"{where}: shipped features take no Roadmap"
    if feature.status in ("partial", "planned"):
        if not roadmap or list(feature.where)[-1] != "Roadmap":
            yield f"{where}: {feature.status} features end the where line with Roadmap: <section>"
        elif roadmap[0] not in surface.roadmap:
            yield f"{where}: Roadmap {roadmap[0]} is not a ROADMAP.md section"
    if feature.status in ("shipped", "partial"):
        yield from stale(feature, surface)


def use_case_problems(case: Feature, names: set[str]) -> Iterator[str]:
    where = f"{case.line}: {case.name}"
    if case.status not in STATUSES:
        yield f"{where}: status {case.status} is not one of {', '.join(STATUSES)}"
    if not case.rest.startswith("uses: "):
        yield f"{where}: a use case ends with uses: <feature>, <feature>"
    for name in items(case.rest.removeprefix("uses: ")):
        if name not in names:
            yield f"{where}: uses {name}, which is not a feature"
    if case.value or case.where:
        yield f"{where}: a use case is one line"


def entries(features: list[Feature], key: str) -> set[str]:
    return {entry for feature in features for entry in feature.where.get(key, [])}


def coverage(features: list[Feature], surface: Surface) -> Iterator[str]:
    listed = entries(features, "API")
    for route in sorted(surface.routes):
        if route.split(" ", 1)[1].startswith(PUBLIC_PREFIXES) and route not in listed:
            yield f"route {route} is in no feature"
    commands = entries(features, "CLI")
    for command in sorted(surface.commands):
        if not any(known_command(entry, frozenset({command})) for entry in commands):
            yield f"command {command} is in no feature"
    config = entries(features, "Config")
    for section in sorted(surface.sections):
        if not any(entry.split(".")[0] == section for entry in config):
            yield f"config section {section} is in no feature"
    for policy in sorted(surface.policies - entries(features, "Policy")):
        yield f"policy {policy} is in no feature"


def check(text: str, surface: Surface) -> list[str]:
    inventory = parse(text)
    found = list(inventory.problems)
    if inventory.areas != list(AREAS):
        found.append(f"areas must be, in order: {', '.join(AREAS)}")
    features = [item for item in inventory.features if item.area != USE_CASES]
    cases = [item for item in inventory.features if item.area == USE_CASES]
    seen: set[str] = set()
    for item in inventory.features:
        if item.name in seen:
            found.append(f"{item.line}: {item.name} is listed twice")
        seen.add(item.name)
    for feature in features:
        found += feature_problems(feature, inventory.users, surface)
    names = {feature.name for feature in features}
    for case in cases:
        found += use_case_problems(case, names)
    found += coverage(features, surface)
    return found


def cli_commands(source: str) -> frozenset[str]:
    parsers: dict[str, tuple[str, ...]] = {}
    groups: dict[str, tuple[str, ...]] = {}
    paths: list[tuple[str, ...]] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Assign | ast.Expr) or not isinstance(node.value, ast.Call):
            continue
        call, func = node.value, node.value.func
        target = node.targets[0] if isinstance(node, ast.Assign) else None
        name = target.id if isinstance(target, ast.Name) else None
        if not isinstance(func, ast.Attribute) or not isinstance(func.value, ast.Name):
            continue
        owner = func.value.id
        if func.attr == "ArgumentParser" and name:
            parsers[name] = ()
        elif func.attr == "add_subparsers" and owner in parsers and name:
            groups[name] = parsers[owner]
        elif func.attr == "add_parser" and owner in groups and call.args and isinstance(call.args[0], ast.Constant):
            path = (*groups[owner], str(call.args[0].value))
            paths.append(path)
            if name:
                parsers[name] = path
    leaves = [path for path in paths if not any(other != path and other[: len(path)] == path for other in paths)]
    return frozenset(" ".join(("minibrain", *path)) for path in leaves)


def walk(routes: list[Any]) -> Iterator[Any]:
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is None:
            yield route
        else:
            yield from walk(included.routes)


def app_routes() -> frozenset[str]:
    from fastapi.routing import APIRoute

    from minibrain.app import create_app
    from minibrain.settings import Settings

    with tempfile.TemporaryDirectory() as home:
        scratch = {"MINIBRAIN_HOME": home, "MINIBRAIN_CONFIG": str(Path(home) / "minibrain.yaml")}
        with mock.patch.dict(os.environ, scratch):
            app = create_app(Settings(home=Path(home), web_dist=Path(home)), background=False)
        routes = [route for route in walk(app.routes) if isinstance(route, APIRoute)]
        return frozenset(f"{method} {route.path}" for route in routes for method in (route.methods or set()) - {"HEAD"})


def surface(root: Path) -> Surface:
    from minibrain.policy import FIELDS
    from minibrain.provision import SECTIONS

    roadmap = re.findall(r"^#+ (.+)$", (root / "ROADMAP.md").read_text(), re.MULTILINE)
    return Surface(
        routes=app_routes(),
        commands=cli_commands((root / "minibrain" / "cli.py").read_text()),
        sections=frozenset(SECTIONS),
        policies=frozenset(item.name for item in FIELDS),
        roadmap=frozenset(title.strip() for title in roadmap),
    )


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else ROOT
    found = check((root / INVENTORY).read_text(), surface(root))
    for problem in found:
        print(f"{INVENTORY}: {problem}")
    print(f"{len(found)} product inventory problems" if found else "Product inventory covers the product")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
