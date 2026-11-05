import re
from collections.abc import Sequence

from minibrain.data.sources import SourceError, quote_identifier, quote_literal, select_from

PLACEHOLDER = re.compile(r"\{([^{}\n]+)\}")
MESSAGES = "messages"
USER = "user"
ASSISTANT = "assistant"

Template = dict[str, str]


def pair_template(input_column: str, label_column: str) -> Template:
    return {USER: "{" + input_column + "}", ASSISTANT: "{" + label_column + "}"}


def chat_template(column: str = MESSAGES) -> Template:
    return {MESSAGES: column}


def is_chat(template: Template) -> bool:
    return MESSAGES in template


def columns_in(text: str) -> list[str]:
    return [match.group(1) for match in PLACEHOLDER.finditer(text)]


def template_columns(template: Template) -> list[str]:
    if is_chat(template):
        return [template[MESSAGES]]
    return list(dict.fromkeys([*columns_in(template.get(USER, "")), *columns_in(template.get(ASSISTANT, ""))]))


def single_column(text: str) -> str | None:
    found = PLACEHOLDER.fullmatch(text.strip())
    return found.group(1) if found else None


def plain_columns(template: Template | None) -> tuple[str | None, str | None]:
    if not template or is_chat(template):
        return None, None
    return single_column(template.get(USER, "")), single_column(template.get(ASSISTANT, ""))


def text_sql(text: str) -> str:
    parts: list[str] = []
    position = 0
    for match in PLACEHOLDER.finditer(text):
        if match.start() > position:
            parts.append(quote_literal(text[position : match.start()]))
        parts.append(f"coalesce(CAST({quote_identifier(match.group(1))} AS VARCHAR), '')")
        position = match.end()
    if position < len(text):
        parts.append(quote_literal(text[position:]))
    if not PLACEHOLDER.search(text):
        raise SourceError("each template names at least one column, such as {text}")
    return " || ".join(parts) if len(parts) > 1 else parts[0]


def plain_sql(column: str) -> str:
    return f"CAST({quote_identifier(column)} AS VARCHAR)"


def slot_sql(text: str) -> str:
    column = single_column(text)
    return plain_sql(column) if column is not None and text.strip() == text else text_sql(text)


def checked(template: Template) -> Template:
    if is_chat(template):
        if set(template) != {MESSAGES} or not template[MESSAGES].strip():
            raise SourceError("a chat mapping names the column that holds the messages")
        return {MESSAGES: template[MESSAGES].strip()}
    if set(template) != {USER, ASSISTANT}:
        raise SourceError("a mapping fills the user and assistant messages, or names a messages column")
    for slot in (USER, ASSISTANT):
        if not columns_in(template[slot]):
            raise SourceError(f"the {slot} message names at least one column, such as {{text}}")
    return dict(template)


def template_sql(template: Template, table: str) -> str:
    found = checked(template)
    if is_chat(found):
        return select_from([(quote_identifier(found[MESSAGES]), MESSAGES)], table)
    return select_from([(slot_sql(found[USER]), "input"), (slot_sql(found[ASSISTANT]), "label")], table)


def missing_columns(template: Template, columns: Sequence[str]) -> list[str]:
    known = set(columns)
    return [name for name in template_columns(template) if name not in known]
