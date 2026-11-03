import json
import math
import re
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from itertools import product
from typing import Any

MAX_CHOICES = 256
MAX_DEPTH = 64
JSON_OBJECT: dict[str, Any] = {"type": "object"}
FENCE = re.compile(r"```[\w-]*[ \t]*\n(.*?)\n?```", re.DOTALL)
ESCAPES = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}

JSON_TYPES: dict[str, Callable[[Any], bool]] = {
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "string": lambda value: isinstance(value, str),
    "boolean": lambda value: isinstance(value, bool),
    "null": lambda value: value is None,
    "number": lambda value: isinstance(value, int | float) and not isinstance(value, bool),
    "integer": lambda value: (
        (isinstance(value, int) and not isinstance(value, bool)) or (isinstance(value, float) and value.is_integer())
    ),
}

SINGLE_SUBSCHEMAS = ("additionalProperties", "additionalItems", "not")
LISTED_SUBSCHEMAS = ("anyOf", "oneOf", "allOf", "prefixItems")
NAMED_SUBSCHEMAS = ("properties", "$defs", "definitions")
COUNTS = ("minLength", "maxLength", "minItems", "maxItems")
BOUNDS = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum")


@dataclass(frozen=True)
class Constraint:
    choices: tuple[str, ...] = ()
    json_schema: dict[str, Any] | None = None

    def options(self) -> tuple[str, ...]:
        if self.choices or self.json_schema is None:
            return self.choices
        return finite_choices(self.json_schema) or ()


def literal(text: str) -> str:
    escaped = "".join(ESCAPES.get(char, char if ord(char) >= 32 else f"\\x{ord(char):02x}") for char in text)
    return f'"{escaped}"'


def choice_grammar(choices: Sequence[str]) -> str:
    return "root ::= " + " | ".join(literal(choice) for choice in choices)


type TrieNode = dict[int, TrieNode]


class TokenTrie:
    def __init__(self, sequences: Sequence[Sequence[int]]) -> None:
        self.root: TrieNode = {}
        for sequence in sequences:
            node = self.root
            for token in sequence:
                node = node.setdefault(token, {})

    def allowed(self, prefix: Sequence[int]) -> list[int]:
        node = self.root
        for token in prefix:
            if token not in node:
                return []
            node = node[token]
        return list(node)


def unfenced(text: str) -> str:
    stripped = text.strip()
    found = FENCE.fullmatch(stripped)
    return found.group(1).strip() if found else stripped


def target(root: Any, ref: str) -> Any:
    if ref != "#" and not ref.startswith("#/"):
        return None
    node = root
    for part in ref[2:].split("/") if ref != "#" else []:
        key = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and key in node:
            node = node[key]
        elif isinstance(node, list) and key.isdigit() and int(key) < len(node):
            node = node[int(key)]
        else:
            return None
    return node


def type_names(value: Any) -> bool:
    names = [value] if isinstance(value, str) else value
    return isinstance(names, list) and bool(names) and all(name in JSON_TYPES for name in names)


def is_schema(value: Any) -> bool:
    return isinstance(value, dict | bool)


def non_empty_list(value: Any) -> bool:
    return isinstance(value, list) and bool(value)


def name_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def is_count(value: Any) -> bool:
    return type(value) is int and value >= 0


def compiles(value: Any) -> bool:
    try:
        re.compile(value)
    except (re.error, TypeError):
        return False
    return True


ShapeRule = tuple[tuple[str, ...], Callable[[Any], bool], str]

SHAPE_RULES: tuple[ShapeRule, ...] = (
    (("type",), type_names, f"a type ({', '.join(JSON_TYPES)}) or a list of types"),
    (("enum",), non_empty_list, "a non-empty list"),
    (("required",), name_list, "a list of property names"),
    (("items",), lambda value: is_schema(value) or isinstance(value, list), "a schema"),
    (("pattern",), compiles, "a valid regular expression"),
    (("$ref",), lambda value: isinstance(value, str), "a reference such as #/$defs/name"),
    (SINGLE_SUBSCHEMAS, is_schema, "a schema"),
    (LISTED_SUBSCHEMAS, non_empty_list, "a non-empty list of schemas"),
    (NAMED_SUBSCHEMAS, is_mapping, "an object of schemas"),
    (COUNTS, is_count, "a non-negative integer"),
    (BOUNDS, JSON_TYPES["number"], "a number"),
)
SHAPES = {key: (fits, shape) for keys, fits, shape in SHAPE_RULES for key in keys}


def subschemas(schema: dict[str, Any]) -> Iterator[tuple[str, Any]]:
    items = schema.get("items")
    if is_schema(items):
        yield "items", items
    for key in SINGLE_SUBSCHEMAS:
        if key in schema:
            yield key, schema[key]
    for key in (*LISTED_SUBSCHEMAS, *(("items",) if isinstance(items, list) else ())):
        for index, sub in enumerate(schema.get(key, [])):
            yield f"{key}[{index}]", sub
    for key in NAMED_SUBSCHEMAS:
        for name, sub in schema.get(key, {}).items():
            yield f"{key}.{name}", sub


def schema_problem(schema: Any, root: Any = None, where: str = "schema", depth: int = 0) -> str | None:
    root = schema if root is None else root
    if isinstance(schema, bool):
        return None
    if not isinstance(schema, dict):
        return f"{where} must be a schema object"
    if depth > MAX_DEPTH:
        return f"{where} nests deeper than {MAX_DEPTH} levels"
    for key, (fits, shape) in SHAPES.items():
        if key in schema and not fits(schema[key]):
            return f"{where}.{key} must be {shape}"
    if "$ref" in schema and not is_schema(target(root, schema["$ref"])):
        return f"{where}.$ref {schema['$ref']} does not point inside this schema"
    for name, sub in subschemas(schema):
        problem = schema_problem(sub, root, f"{where}.{name}", depth + 1)
        if problem is not None:
            return problem
    return None


def same(left: Any, right: Any) -> bool:
    return left == right and isinstance(left, bool) == isinstance(right, bool)


def shown(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


Check = Callable[[dict[str, Any], Any, Any, str, int], str | None]


def check_ref(schema: dict[str, Any], value: Any, root: Any, path: str, depth: int) -> str | None:
    ref = schema.get("$ref")
    return violation(target(root, ref), value, root, path, depth + 1) if isinstance(ref, str) else None


def check_type(schema: dict[str, Any], value: Any, _root: Any, path: str, _depth: int) -> str | None:
    kinds = schema.get("type")
    if kinds is None:
        return None
    names = [kinds] if isinstance(kinds, str) else list(kinds)
    return None if any(JSON_TYPES[name](value) for name in names) else f"{path} must be {' or '.join(names)}"


def check_values(schema: dict[str, Any], value: Any, _root: Any, path: str, _depth: int) -> str | None:
    if "const" in schema and not same(value, schema["const"]):
        return f"{path} must be {shown(schema['const'])}"
    options = schema.get("enum")
    if options is not None and not any(same(value, option) for option in options):
        return f"{path} must be one of {', '.join(shown(option) for option in options)}"
    return None


def check_object(schema: dict[str, Any], value: Any, root: Any, path: str, depth: int) -> str | None:
    if not isinstance(value, dict):
        return None
    missing = [name for name in schema.get("required", []) if name not in value]
    if missing:
        return f"{path}.{missing[0]} is required"
    properties = schema.get("properties", {})
    extra = schema.get("additionalProperties", True)
    for key, item in value.items():
        problem = violation(properties.get(key, extra), item, root, f"{path}.{key}", depth + 1)
        if problem is not None:
            return problem
    return None


def check_array(schema: dict[str, Any], value: Any, root: Any, path: str, depth: int) -> str | None:
    if not isinstance(value, list):
        return None
    if len(value) < schema.get("minItems", 0):
        return f"{path} needs at least {schema['minItems']} items"
    if "maxItems" in schema and len(value) > schema["maxItems"]:
        return f"{path} allows at most {schema['maxItems']} items"
    items = schema.get("items", True)
    prefix, rest = (items, schema.get("additionalItems", True)) if isinstance(items, list) else ([], items)
    prefix = schema.get("prefixItems", prefix)
    for index, item in enumerate(value):
        sub = prefix[index] if index < len(prefix) else rest
        problem = violation(sub, item, root, f"{path}[{index}]", depth + 1)
        if problem is not None:
            return problem
    return None


def check_string(schema: dict[str, Any], value: Any, _root: Any, path: str, _depth: int) -> str | None:
    if not isinstance(value, str):
        return None
    if len(value) < schema.get("minLength", 0):
        return f"{path} needs at least {schema['minLength']} characters"
    if "maxLength" in schema and len(value) > schema["maxLength"]:
        return f"{path} allows at most {schema['maxLength']} characters"
    return None


def check_number(schema: dict[str, Any], value: Any, _root: Any, path: str, _depth: int) -> str | None:
    if not JSON_TYPES["number"](value):
        return None
    limits: tuple[tuple[str, Callable[[Any], bool], str], ...] = (
        ("minimum", lambda bound: value >= bound, "at least"),
        ("maximum", lambda bound: value <= bound, "at most"),
        ("exclusiveMinimum", lambda bound: value > bound, "more than"),
        ("exclusiveMaximum", lambda bound: value < bound, "less than"),
    )
    for key, holds, words in limits:
        if key in schema and not holds(schema[key]):
            return f"{path} must be {words} {schema[key]}"
    return None


def check_combined(schema: dict[str, Any], value: Any, root: Any, path: str, depth: int) -> str | None:
    for sub in schema.get("allOf", []):
        problem = violation(sub, value, root, path, depth + 1)
        if problem is not None:
            return problem
    if "anyOf" in schema and all(violation(sub, value, root, path, depth + 1) for sub in schema["anyOf"]):
        return f"{path} matches none of anyOf"
    if "oneOf" in schema and sum(violation(sub, value, root, path, depth + 1) is None for sub in schema["oneOf"]) != 1:
        return f"{path} must match exactly one of oneOf"
    if "not" in schema and violation(schema["not"], value, root, path, depth + 1) is None:
        return f"{path} must not match the not schema"
    return None


CHECKS: tuple[Check, ...] = (
    check_ref,
    check_type,
    check_values,
    check_object,
    check_array,
    check_string,
    check_number,
    check_combined,
)


def violation(schema: Any, value: Any, root: Any = None, path: str = "$", depth: int = 0) -> str | None:
    root = schema if root is None else root
    if schema is False:
        return f"{path} is not allowed"
    if not isinstance(schema, dict):
        return None
    if depth > MAX_DEPTH:
        return f"{path} nests deeper than {MAX_DEPTH} levels"
    for check in CHECKS:
        problem = check(schema, value, root, path, depth)
        if problem is not None:
            return problem
    return None


def object_values(schema: dict[str, Any], root: Any, depth: int) -> list[Any] | None:
    properties: dict[str, Any] = schema.get("properties", {})
    if not properties or set(schema.get("required", [])) != set(properties):
        return None
    options: list[list[Any]] = []
    for sub in properties.values():
        found = finite_values(sub, root, depth + 1)
        if found is None:
            return None
        options.append(found)
    if math.prod(len(option) for option in options) > MAX_CHOICES:
        return None
    return [dict(zip(properties, combination, strict=True)) for combination in product(*options)]


def union_values(schemas: list[Any], root: Any, depth: int) -> list[Any] | None:
    values: list[Any] = []
    for sub in schemas:
        found = finite_values(sub, root, depth + 1)
        if found is None:
            return None
        values += found
    return values


def candidate_values(schema: dict[str, Any], root: Any, depth: int) -> list[Any] | None:
    if isinstance(schema.get("$ref"), str):
        return finite_values(target(root, schema["$ref"]), root, depth + 1)
    if "const" in schema:
        return [schema["const"]]
    if "enum" in schema:
        return list(schema["enum"])
    if "anyOf" in schema:
        return union_values(schema["anyOf"], root, depth)
    kind = schema.get("type")
    if kind == "boolean":
        return [False, True]
    if kind == "null":
        return [None]
    return object_values(schema, root, depth) if kind == "object" else None


def finite_values(schema: Any, root: Any, depth: int = 0) -> list[Any] | None:
    if not isinstance(schema, dict) or depth > MAX_DEPTH:
        return None
    found = candidate_values(schema, root, depth)
    if found is None or len(found) > MAX_CHOICES:
        return None
    return [value for value in found if violation(schema, value, root, "$", depth) is None]


def finite_choices(schema: dict[str, Any]) -> tuple[str, ...] | None:
    values = finite_values(schema, schema)
    return tuple(dict.fromkeys(shown(value) for value in values)) if values else None
