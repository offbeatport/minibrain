from collections.abc import Iterable

SYSTEM_PREFIX = "minibrain:"
MAX_TAG_LENGTH = 64
MAX_TAGS = 20


class TagError(ValueError):
    pass


def normalize(tag: str) -> str:
    text = " ".join(tag.split())
    key, colon, value = text.partition(":")
    if not colon:
        return text
    return f"{key.strip().lower()}:{value.strip()}"


def is_system(tag: str) -> bool:
    return tag.lower().startswith(SYSTEM_PREFIX)


def user_tags(tags: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    cleaned: list[str] = []
    for raw in tags:
        tag = normalize(raw)
        if not tag:
            continue
        if is_system(tag):
            raise TagError(f"tags starting with {SYSTEM_PREFIX} are set by minibrain")
        if len(tag) > MAX_TAG_LENGTH:
            raise TagError(f"a tag can be at most {MAX_TAG_LENGTH} characters")
        if tag.startswith(":") or tag.endswith(":"):
            raise TagError("a key:value tag needs both a key and a value")
        if tag.lower() not in seen:
            seen.add(tag.lower())
            cleaned.append(tag)
    if len(cleaned) > MAX_TAGS:
        raise TagError(f"at most {MAX_TAGS} tags")
    return cleaned


def merged_tags(current: Iterable[str] | None, requested: Iterable[str]) -> list[str]:
    kept = [tag for tag in current or [] if is_system(tag)]
    return kept + user_tags(requested)
