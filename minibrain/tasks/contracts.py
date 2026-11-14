import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from minibrain.serve.structured import Constraint, schema_problem, unfenced, violation

TEXT = "text"
JSON = "json"
LABEL_FIELD = "label"
MAX_LABELS = 256
DESCRIPTIVE = frozenset({"title", "description", "examples", "default", "$comment"})
STRUCTURAL = frozenset({"type", "properties", "required", "enum", "items", "additionalProperties"})

ContractKind = Literal["text", "json"]


class ContractError(ValueError):
    pass


@dataclass(frozen=True)
class Contract:
    kind: ContractKind
    schema: dict[str, Any] | None = None

    @property
    def labels(self) -> tuple[str, ...] | None:
        return labels_in(self.schema) if self.kind == JSON else None

    def as_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "schema": self.schema}

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> "Contract":
        if not data:
            return FREE_TEXT
        kind = data.get("kind")
        if kind == TEXT:
            return FREE_TEXT
        if kind != JSON:
            raise ContractError("a contract is free text or a JSON schema")
        return json_contract(data.get("schema"))


FREE_TEXT = Contract(kind=TEXT)


@dataclass(frozen=True)
class Answer:
    text: str
    value: Any
    valid: bool


@dataclass(frozen=True)
class Change:
    path: str
    detail: str
    breaking: bool

    def as_dict(self) -> dict[str, Any]:
        return {"path": self.path, "detail": self.detail, "breaking": self.breaking}


def labels_in(schema: dict[str, Any] | None) -> tuple[str, ...] | None:
    if not isinstance(schema, dict) or set(schema.get("properties") or {}) != {LABEL_FIELD}:
        return None
    field = schema["properties"][LABEL_FIELD]
    options = field.get("enum") if isinstance(field, dict) else None
    if schema.get("required") != [LABEL_FIELD] or not isinstance(options, list):
        return None
    return tuple(str(option) for option in options) if all(isinstance(o, str) for o in options) else None


def label_set(labels: Sequence[str]) -> Contract:
    found = list(dict.fromkeys(label.strip() for label in labels if label.strip()))
    if len(found) < 2:
        raise ContractError("a label set needs at least two labels")
    if len(found) > MAX_LABELS:
        raise ContractError(f"a label set holds at most {MAX_LABELS} labels")
    schema = {
        "type": "object",
        "properties": {LABEL_FIELD: {"type": "string", "enum": found}},
        "required": [LABEL_FIELD],
        "additionalProperties": False,
    }
    return Contract(kind=JSON, schema=schema)


def json_contract(schema: Any) -> Contract:
    if not isinstance(schema, dict):
        raise ContractError("a JSON contract needs a JSON Schema object")
    problem = schema_problem(schema)
    if problem is not None:
        raise ContractError(f"Invalid JSON Schema: {problem}")
    if schema.get("type") != "object":
        raise ContractError('the schema must describe an object: {"type": "object", "properties": {...}}')
    return Contract(kind=JSON, schema=schema)


def with_labels(contract: Contract, labels: Sequence[str]) -> Contract:
    current = list(contract.labels or ())
    return label_set([*current, *(label for label in sorted(labels) if label not in current)])


def constraint(contract: Contract) -> Constraint | None:
    if contract.labels is not None:
        return Constraint(choices=contract.labels)
    if contract.kind == JSON and contract.schema is not None:
        return Constraint(json_schema=contract.schema)
    return None


def parse_label(output: str, labels: Sequence[str]) -> str | None:
    lines = output.strip().splitlines()
    candidate = lines[0].strip().strip("`'\".").lower() if lines else ""
    return {label.lower(): label for label in labels}.get(candidate)


def parse_json(output: str) -> tuple[bool, Any]:
    try:
        return True, json.loads(unfenced(output))
    except json.JSONDecodeError:
        return False, None


def answer_of(contract: Contract, output: str) -> Answer:
    labels = contract.labels
    if labels is not None:
        label = parse_label(output, labels)
        return Answer(text=output, value=label, valid=label is not None)
    if contract.kind == JSON:
        parsed, value = parse_json(output)
        valid = parsed and contract.schema is not None and violation(contract.schema, value) is None
        return Answer(text=output, value=value, valid=valid)
    return Answer(text=output, value=output.strip(), valid=True)


def required_of(schema: dict[str, Any]) -> set[str]:
    found = schema.get("required")
    return {str(name) for name in found} if isinstance(found, list) else set()


def enum_changes(path: str, old: list[Any], new: list[Any]) -> list[Change]:
    removed = [value for value in old if value not in new]
    added = [value for value in new if value not in old]
    found = [Change(path, f"removes {json.dumps(value)}", True) for value in removed]
    return found + [Change(path, f"adds {json.dumps(value)}", False) for value in added]


def property_changes(path: str, old: dict[str, Any], new: dict[str, Any]) -> list[Change]:
    before, after = old.get("properties") or {}, new.get("properties") or {}
    was, now = required_of(old), required_of(new)
    found: list[Change] = []
    for name in before:
        where = f"{path}.{name}"
        if name not in after:
            found.append(Change(where, "removes the field (renaming one removes it too)", True))
        elif (name in was) != (name in now):
            found.append(Change(where, "becomes required" if name in now else "stops being required", True))
        else:
            found += schema_changes(where, before[name], after[name])
    for name in after:
        if name not in before:
            optional = name not in now
            detail = "adds an optional field" if optional else "adds a required field"
            found.append(Change(f"{path}.{name}", detail, not optional))
    return found


def schema_changes(path: str, old: Any, new: Any) -> list[Change]:
    if not isinstance(old, dict) or not isinstance(new, dict):
        return [] if old == new else [Change(path, "changes its schema", True)]
    found: list[Change] = []
    if old.get("type") != new.get("type"):
        found.append(Change(path, f"changes type from {old.get('type')} to {new.get('type')}", True))
    if "enum" in old or "enum" in new:
        if "enum" in old and "enum" in new:
            found += enum_changes(path, list(old["enum"]), list(new["enum"]))
        else:
            found.append(Change(path, "adds a value list" if "enum" in new else "drops its value list", True))
    if "properties" in old or "properties" in new:
        found += property_changes(path, old, new)
    if "items" in old or "items" in new:
        found += schema_changes(f"{path}[]", old.get("items", True), new.get("items", True))
    if old.get("additionalProperties", True) != new.get("additionalProperties", True):
        found.append(Change(path, "changes which extra fields are allowed", True))
    others = (set(old) | set(new)) - DESCRIPTIVE - STRUCTURAL
    found += [Change(path, f"changes {key}", True) for key in sorted(others) if old.get(key) != new.get(key)]
    return found


def changes(old: Contract, new: Contract) -> list[Change]:
    if old.kind != new.kind:
        return [Change("$", f"changes the answer from {old.kind} to {new.kind}", True)]
    if old.kind == TEXT:
        return []
    old_labels, new_labels = old.labels, new.labels
    if (old_labels is None) != (new_labels is None):
        return [Change("$", "switches between a label set and a JSON schema", True)]
    if old_labels is not None and new_labels is not None:
        return enum_changes("label", list(old_labels), list(new_labels))
    return schema_changes("$", old.schema, new.schema)


def breaking_changes(old: Contract, new: Contract) -> list[Change]:
    return [change for change in changes(old, new) if change.breaking]


def described(found: Sequence[Change]) -> str:
    return "; ".join(f"{change.path} {change.detail}" for change in found)


JSON_SHARE = 0.9
PYTHON_TYPES: tuple[tuple[type, str], ...] = (
    (bool, "boolean"),
    (int, "integer"),
    (float, "number"),
    (str, "string"),
    (list, "array"),
    (dict, "object"),
)


@dataclass(frozen=True)
class Suggestion:
    contract: Contract
    basis: str


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    return next(name for kind, name in PYTHON_TYPES if isinstance(value, kind))


def value_schema(values: Sequence[Any]) -> dict[str, Any]:
    kinds = list(dict.fromkeys(json_type(value) for value in values))
    if "number" in kinds and "integer" in kinds:
        kinds.remove("integer")
    if kinds == ["object"]:
        return object_schema(values)
    if kinds == ["array"]:
        items = [item for value in values for item in value]
        return {"type": "array", "items": value_schema(items)} if items else {"type": "array"}
    if not kinds:
        return {}
    return {"type": kinds[0]} if len(kinds) == 1 else {"type": kinds}


def object_schema(objects: Sequence[dict[str, Any]]) -> dict[str, Any]:
    names = list(dict.fromkeys(name for item in objects for name in item))
    return {
        "type": "object",
        "properties": {name: value_schema([item[name] for item in objects if name in item]) for name in names},
        "required": [name for name in names if all(name in item for item in objects)],
    }


def suggested_contract(labels: Sequence[str], answers: Sequence[str]) -> Suggestion:
    if len(labels) >= 2:
        return Suggestion(label_set(labels), f"{len(labels)} distinct answers in the data")
    texts = [answer for answer in answers if answer.strip()]
    parsed = (parse_json(text) for text in texts)
    objects = [value for ok, value in parsed if ok and isinstance(value, dict)]
    if objects and len(objects) >= JSON_SHARE * len(texts):
        return Suggestion(json_contract(object_schema(objects)), "the answers in the data are JSON objects")
    return Suggestion(FREE_TEXT, "the answers in the data are free text")
