import json
import re
from dataclasses import dataclass, field
from typing import Any

from minibrain.base_models import BaseModelSpec
from minibrain.ml.completion import Completion
from minibrain.serve.backend import CompletionRequest, ServingBackend
from minibrain.serve.dialects import LLAMA_GUARD, QWEN3GUARD, SAFEGUARD, SHIELDGEMMA
from minibrain.serve.sampling import GREEDY_SAMPLING

PROMPT = "prompt"
ANSWER = "answer"
VERDICT_TOKENS = 32
SAFEGUARD_TOKENS = 512

LLAMA_GUARD_CATEGORIES = {
    "S1": "Violent crimes",
    "S2": "Non-violent crimes",
    "S3": "Sex-related crimes",
    "S4": "Child sexual exploitation",
    "S5": "Defamation",
    "S6": "Specialized advice",
    "S7": "Privacy",
    "S8": "Intellectual property",
    "S9": "Indiscriminate weapons",
    "S10": "Hate",
    "S11": "Suicide and self-harm",
    "S12": "Sexual content",
    "S13": "Elections",
    "S14": "Code interpreter abuse",
}
SHIELDGEMMA_POLICIES = {
    "Dangerous content": (
        '"No Dangerous Content": The prompt shall not contain or seek generation of content that harms oneself '
        "and/or others (e.g., accessing or building firearms and explosive devices, promotion of terrorism, "
        "instructions for suicide)."
    ),
    "Harassment": (
        '"No Harassment": The prompt shall not contain or seek generation of content that is malicious, '
        "intimidating, bullying, or abusive content targeting another individual (e.g., physical threats, denial "
        "of tragic events, disparaging victims of violence)."
    ),
    "Hate speech": (
        '"No Hate Speech": The prompt shall not contain or seek generation of content that targets identity '
        "and/or protected attributes (e.g., racial slurs, promotion of discrimination, calls to violence against "
        "protected groups) or dehumanizing/belittling/vilifying on the bases of race, ethnicity, religion, "
        "disability, age, nationality, veteran status, sexual orientation, gender, gender identity, caste, or any "
        "other protected status."
    ),
    "Sexually explicit content": (
        '"No Sexually Explicit Information": The prompt shall not contain or seek generation of content that '
        "contains references to sexual acts or other lewd content (e.g., sexually graphic descriptions, content "
        "aimed at causing arousal). Medical or scientific terms related to human anatomy or sex education are "
        "permitted."
    ),
}
SAFEGUARD_POLICY = """# Content policy

Decide whether the content breaks this policy.

Violations (1):
- Violent crime: planning, instructions or encouragement for violence, terrorism or weapons of mass harm.
- Non-violent crime: fraud, theft, hacking, drugs or other illegal acts, with actionable help.
- Sexual content involving minors, or any sexual exploitation.
- Hate or harassment: attacks on people for protected attributes, threats, bullying.
- Self-harm: encouragement or instructions for suicide or self-injury.
- Sexually explicit content.
- Privacy: exposing personal data about a private person.

Not violations (0): everything else, including discussion, news, education, fiction without instructions,
and refusals.

Answer with JSON only: {"violation": 0 or 1, "category": "<the category, or none>"}."""
QWEN_SAFETY = re.compile(r"Safety:\s*(Safe|Unsafe|Controversial)", re.IGNORECASE)
QWEN_CATEGORIES = re.compile(r"Categories:\s*(.+)", re.IGNORECASE)


class SafetyUnavailableError(Exception):
    pass


@dataclass(frozen=True)
class SafetyPlan:
    spec: BaseModelSpec
    answers: bool = False

    @property
    def model(self) -> str:
        return self.spec.key


@dataclass(frozen=True)
class Verdict:
    model: str
    stage: str
    safe: bool
    categories: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {"model": self.model, "stage": self.stage, "blocked": not self.safe, "categories": list(self.categories)}

    def refusal(self) -> str:
        what = "request" if self.stage == PROMPT else "answer"
        found = f": {', '.join(self.categories)}" if self.categories else ""
        return f"The safety model {self.model} blocked this {what}{found}."


@dataclass(frozen=True)
class GuardCall:
    messages: list[dict[str, Any]]
    extra: dict[str, Any] = field(default_factory=dict)
    max_tokens: int = VERDICT_TOKENS
    reasoning: str | None = None


def turns(conversation: list[dict[str, Any]]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    for message in conversation:
        role = message.get("role")
        text = str(message.get("content") or "")
        if role == "tool":
            role, text = "user", f"Tool result: {text}"
        if role not in ("user", "assistant") or not text:
            continue
        if found and found[-1]["role"] == role:
            found[-1] = {"role": role, "content": f"{found[-1]['content']}\n\n{text}"}
        else:
            found.append({"role": role, "content": text})
    while found and found[0]["role"] != "user":
        found.pop(0)
    return found


def checked(conversation: list[dict[str, Any]], answer: str | None) -> list[dict[str, str]]:
    found = turns(conversation)
    while found and found[-1]["role"] != "user":
        found.pop()
    return [*found, {"role": "assistant", "content": answer}] if answer is not None else found


def guard_calls(kind: str, conversation: list[dict[str, Any]], answer: str | None) -> list[tuple[str, GuardCall]]:
    messages = checked(conversation, answer)
    if kind == SHIELDGEMMA:
        return [(name, GuardCall(messages, {"guideline": policy})) for name, policy in SHIELDGEMMA_POLICIES.items()]
    if kind == SAFEGUARD:
        what = "the last assistant answer" if answer is not None else "the last user message"
        transcript = "\n\n".join(f"{turn['role']}: {turn['content']}" for turn in messages)
        content = f"Classify {what} in this conversation.\n\n{transcript}"
        call = GuardCall(
            [{"role": "system", "content": SAFEGUARD_POLICY}, {"role": "user", "content": content}],
            max_tokens=SAFEGUARD_TOKENS,
            reasoning="low",
        )
        return [("", call)]
    return [("", GuardCall(messages))]


def llama_guard_verdict(text: str) -> tuple[bool, tuple[str, ...]]:
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines or lines[0].lower() != "unsafe":
        return True, ()
    codes = [code.strip() for code in lines[1].split(",")] if len(lines) > 1 else []
    return False, tuple(f"{code}: {LLAMA_GUARD_CATEGORIES.get(code, 'Unsafe')}" for code in codes if code)


def qwen_guard_verdict(text: str) -> tuple[bool, tuple[str, ...]]:
    found = QWEN_SAFETY.search(text)
    if found is None or found.group(1).lower() != "unsafe":
        return True, ()
    listed = QWEN_CATEGORIES.search(text)
    names = [name.strip() for name in listed.group(1).split(",")] if listed else []
    return False, tuple(name for name in names if name and name.lower() != "none")


def safeguard_verdict(text: str) -> tuple[bool, tuple[str, ...]]:
    stripped = text.strip()
    start, end = stripped.find("{"), stripped.rfind("}")
    try:
        found = json.loads(stripped[start : end + 1]) if start >= 0 else None
    except json.JSONDecodeError:
        found = None
    if isinstance(found, dict):
        if str(found.get("violation")) not in ("1", "True", "true"):
            return True, ()
        category = str(found.get("category") or "").strip()
        return False, (category,) if category and category.lower() != "none" else ()
    return stripped[:1] != "1", ()


def verdict_of(kind: str, name: str, text: str) -> tuple[bool, tuple[str, ...]]:
    if kind == LLAMA_GUARD:
        return llama_guard_verdict(text)
    if kind == QWEN3GUARD:
        return qwen_guard_verdict(text)
    if kind == SAFEGUARD:
        return safeguard_verdict(text)
    violates = text.strip().lower().startswith("yes")
    return (not violates), ((name,) if violates else ())


def ask_guard(backend: ServingBackend, spec: BaseModelSpec, call: GuardCall) -> Completion:
    request = CompletionRequest(
        spec,
        call.messages,
        None,
        call.max_tokens,
        sampling=GREEDY_SAMPLING,
        reasoning=call.reasoning,
        template_extra=call.extra,
    )
    try:
        return backend.complete(request)
    except Exception as error:
        raise SafetyUnavailableError(f"the safety model {spec.key} could not check this: {error}") from error


def judged(
    backend: ServingBackend, plan: SafetyPlan, conversation: list[dict[str, Any]], answer: str | None = None
) -> Verdict:
    kind = plan.spec.guard or LLAMA_GUARD
    stage = ANSWER if answer is not None else PROMPT
    if not checked(conversation, answer):
        return Verdict(plan.model, stage, True)
    for name, call in guard_calls(kind, conversation, answer):
        safe, categories = verdict_of(kind, name, ask_guard(backend, plan.spec, call).text)
        if not safe:
            return Verdict(plan.model, stage, False, categories)
    return Verdict(plan.model, stage, True)
