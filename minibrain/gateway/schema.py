from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from minibrain.serve.sampling import MAX_STOPS

MAX_TOOLS = 128
FORMAT_HELP = (
    'An OpenAI response_format: {"type": "text"}, {"type": "json_object"} or '
    '{"type": "json_schema", "json_schema": {"name": ..., "schema": {...}, "strict": true}}. '
    "A custom model's contract holds by default; a request's format can only narrow a model whose contract is "
    "free text, so a model answering with labels or its own schema refuses one."
)
MODEL_HELP = (
    "A name from GET /models: a custom model follows its live version, name@3 pins version 3, "
    "and a served base model goes by its key."
)
TEXT_MAX_TOKENS = 16
TEXT_HELP = (
    "Continue a prompt, as the legacy OpenAI completions API does: the text goes to the model as it is, without "
    "the chat template, which suits code completion and base models. A custom model applies its adapter but not its "
    "instructions or contract. Every call is logged without its content, unless the model keeps request inputs and "
    "answers."
)
PROMPT_HELP = "The text to continue, sent as it is; a list holding one text works too. Token ids are not read."
CHAT_HELP = (
    "Answer a conversation with a model. Every call is logged without its content, "
    "unless the model keeps request inputs and answers."
)
MESSAGES_HELP = (
    "The conversation: system (or developer), user, assistant and tool messages. A custom model answers after its "
    "own instructions, without the app's system messages; a base model reads them all."
)
TOOLS_HELP = (
    f"Up to {MAX_TOOLS} functions the model may call. Each model family's chat template renders them, and its "
    "answer is read back as tool_calls: Qwen and Hermes <tool_call> JSON, Llama 3.1 and later JSON, Mistral "
    "[TOOL_CALLS] and gpt-oss harmony. A model answering with labels or a JSON schema takes no tools."
)
REASONING_HELP = (
    "none turns reasoning off; low, medium or high turn it on at that effort; unset keeps the model's default (off "
    "for custom models and the catalogue's Qwen3 bases). Qwen3 and GLM think or not, so any effort turns thinking "
    "on; gpt-oss always reasons at an effort; DeepSeek-R1 always reasons. The reasoning comes back apart from the "
    "answer, as message.reasoning_content."
)
SAFETY_HELP = (
    "A minibrain extension: check the request with a safety model on this install (Llama Guard, ShieldGemma, "
    "Qwen3Guard, gpt-oss-safeguard), and the answer too with answers: true. A model with a safety model set in "
    "Settings or on its page is always checked by it; a request can add the answer check but not change or turn "
    "off that model. A blocked request answers with message.refusal and finish_reason content_filter."
)
TOOL_CHOICE_HELP = (
    "auto (the default with tools) lets the model choose, none answers in text, required makes it call one, and "
    '{"type": "function", "function": {"name": ...}} makes it call that one.'
)


class FunctionCallBody(BaseModel):
    name: str
    arguments: str = Field(description="The arguments as a JSON object in text.")


class ToolCallBody(BaseModel):
    id: str
    type: Literal["function"] = "function"
    function: FunctionCallBody


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: str = Field(description="system, developer, user, assistant or tool.")
    content: str | list[dict[str, Any]] | None = Field(
        default=None, description="Text, or a list of text parts; empty on an assistant message that calls tools."
    )
    name: str | None = Field(default=None, description="The function's name, on a tool message.")
    tool_calls: list[ToolCallBody] | None = Field(
        default=None, description="On an assistant message: the calls it made, sent back with their results."
    )
    tool_call_id: str | None = Field(default=None, description="On a tool message: the id of the call it answers.")


class FunctionSpec(BaseModel):
    name: str = Field(description="1 to 64 letters, digits, underscores or dashes.")
    description: str | None = Field(default=None, description="What the function does, for the model.")
    parameters: dict[str, Any] | None = Field(default=None, description="The arguments, as a JSON Schema object.")
    strict: bool | None = Field(default=None, description="Accepted; the arguments are not constrained.")


class ToolSpec(BaseModel):
    type: Literal["function"] = "function"
    function: FunctionSpec


class SafetyRequest(BaseModel):
    model: str | None = Field(default=None, description="A safety model's key, or none.")
    answers: bool | None = Field(default=None, description="Check the answer as well as the request.")


Temperature = Annotated[
    float | None,
    Field(
        ge=0,
        le=2,
        description="0 to 2: higher is more varied, 0 picks the likeliest token every time. Unset: the model's "
        "default; custom models answer at 0, the way their scores were measured.",
    ),
]
TopP = Annotated[
    float | None,
    Field(
        gt=0,
        le=1,
        description="Above 0, up to 1: sample only from the likeliest tokens whose probabilities add up to top_p.",
    ),
]
TopK = Annotated[
    int | None, Field(ge=1, description="Sample only from the k likeliest tokens. An extension vLLM and SGLang share.")
]
MinP = Annotated[
    float | None,
    Field(
        ge=0,
        le=1,
        description="0 to 1: drop tokens less likely than min_p times the likeliest one. An engine extension.",
    ),
]
PresencePenalty = Annotated[
    float | None, Field(ge=-2, le=2, description="-2 to 2: above 0 favours tokens that have not appeared yet.")
]
FrequencyPenalty = Annotated[
    float | None, Field(ge=-2, le=2, description="-2 to 2: above 0 lowers a token's odds the more often it appeared.")
]
RepetitionPenalty = Annotated[
    float | None,
    Field(
        gt=0,
        le=2,
        description="Above 0, up to 2: above 1 discourages repeating any token seen so far. An engine extension.",
    ),
]
Seed = Annotated[
    int | None, Field(description="Sample the same way for the same seed and inputs, as far as the engine allows.")
]
Stop = Annotated[
    str | list[str] | None,
    Field(description=f"Up to {MAX_STOPS} texts that end the answer; the text itself is not returned."),
]
Single = Annotated[int | None, Field(ge=1, le=1, description="How many answers; only 1 is supported.")]
Stream = Annotated[bool, Field(description="Send the answer as server-sent events, ending with data: [DONE].")]
Safety = Annotated[SafetyRequest | None, Field(description=SAFETY_HELP)]


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
        json_schema_extra={
            "example": {"model": "support-triage", "messages": [{"role": "user", "content": "I was charged twice"}]}
        },
    )

    model: str = Field(description=MODEL_HELP)
    messages: list[Message] = Field(min_length=1, description=MESSAGES_HELP)
    max_tokens: int | None = Field(
        default=None, ge=1, description="The most tokens to answer with. Unset: up to the model's context limit."
    )
    max_completion_tokens: int | None = Field(
        default=None, ge=1, description="The same as max_tokens, under its newer name; it wins when both are set."
    )
    temperature: Temperature = None
    top_p: TopP = None
    top_k: TopK = None
    min_p: MinP = None
    presence_penalty: PresencePenalty = None
    frequency_penalty: FrequencyPenalty = None
    repetition_penalty: RepetitionPenalty = None
    seed: Seed = None
    stop: Stop = None
    n: Single = None
    stream: Stream = False
    response_format: Any = Field(default=None, description=FORMAT_HELP)
    tools: list[ToolSpec] | None = Field(default=None, max_length=MAX_TOOLS, description=TOOLS_HELP)
    tool_choice: str | dict[str, Any] | None = Field(default=None, description=TOOL_CHOICE_HELP)
    parallel_tool_calls: bool | None = Field(
        default=None, description="false keeps only the first call the model makes; true (the default) keeps all."
    )
    reasoning_effort: Literal["none", "low", "medium", "high"] | None = Field(default=None, description=REASONING_HELP)
    safety: Safety = None

    @property
    def token_budget(self) -> int | None:
        return self.max_completion_tokens or self.max_tokens


class TextCompletionRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
        json_schema_extra={"example": {"model": "qwen3-0.6b", "prompt": "def fibonacci(n):", "max_tokens": 64}},
    )

    model: str = Field(description=MODEL_HELP)
    prompt: str | list[str] | list[int] | list[list[int]] = Field(description=PROMPT_HELP)
    max_tokens: int | None = Field(
        default=TEXT_MAX_TOKENS, ge=1, description=f"The most tokens to answer with; {TEXT_MAX_TOKENS} when unset."
    )
    temperature: Temperature = None
    top_p: TopP = None
    top_k: TopK = None
    min_p: MinP = None
    presence_penalty: PresencePenalty = None
    frequency_penalty: FrequencyPenalty = None
    repetition_penalty: RepetitionPenalty = None
    seed: Seed = None
    stop: Stop = None
    n: Single = None
    best_of: int | None = Field(default=None, ge=1, le=1, description="Only 1 is supported.")
    stream: Stream = False
    logprobs: int | None = Field(default=None, description="Not returned; leave it unset.")
    echo: bool | None = Field(default=None, description="Not supported; leave it unset or false.")
    suffix: str | None = Field(default=None, description="Not supported; leave it unset.")
    user: str | None = Field(default=None, description="Accepted and ignored.")
    safety: Safety = None

    @property
    def token_budget(self) -> int | None:
        return self.max_tokens


class TextChoice(BaseModel):
    index: int
    text: str = Field(description="The text that follows the prompt; empty when the safety model blocked the call.")
    logprobs: None = None
    finish_reason: Literal["stop", "length", "content_filter"] = Field(
        description="stop when the text ended or hit a stop text, length when max_tokens cut it, content_filter when "
        "the safety model blocked it."
    )


class ModelInfo(BaseModel):
    id: str = Field(description="The name to send as model.")
    object: Literal["model"] = "model"
    created: int
    owned_by: str


class ModelList(BaseModel):
    object: Literal["list"] = "list"
    data: list[ModelInfo]


class AnswerMessage(BaseModel):
    role: Literal["assistant"]
    content: str | None = Field(description="The answer; null when the model only calls tools.")
    reasoning_content: str | None = Field(
        default=None, description="The model's reasoning before the answer, when it reasons; never part of content."
    )
    tool_calls: list[ToolCallBody] | None = Field(
        default=None, description="The functions the model calls; answer each with a tool message."
    )
    refusal: str | None = Field(
        default=None, description="Why the safety model blocked the request or the answer, with its categories."
    )


class CompletionChoice(BaseModel):
    index: int
    message: AnswerMessage
    finish_reason: Literal["stop", "length", "tool_calls", "content_filter"] = Field(
        description="stop when the answer ended, length when max_tokens cut it, tool_calls when it calls tools, "
        "content_filter when the safety model blocked it."
    )


class SafetyVerdict(BaseModel):
    model: str = Field(description="The safety model that checked the call.")
    stage: Literal["prompt", "answer"] = Field(description="What it checked last: the request or the answer.")
    blocked: bool
    categories: list[str] = Field(description="The categories it found, in the safety model's own words.")


class TokenUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletion(BaseModel):
    id: str = Field(description="The response id; send it as response_id to POST /feedback.")
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[CompletionChoice]
    usage: TokenUsage
    safety: SafetyVerdict | None = Field(default=None, description="Present when a safety model checked the call.")


class TextCompletion(BaseModel):
    id: str = Field(description="The response id; send it as response_id to POST /feedback.")
    object: Literal["text_completion"]
    created: int
    model: str
    choices: list[TextChoice]
    usage: TokenUsage
    safety: SafetyVerdict | None = Field(default=None, description="Present when a safety model checked the call.")


class ErrorInfo(BaseModel):
    message: str
    type: str
    param: str | None
    code: str | None


class OpenAIErrorBody(BaseModel):
    error: ErrorInfo


class ErrorDetail(BaseModel):
    detail: str


Responses = dict[int | str, dict[str, Any]]

KEY_ERRORS: Responses = {
    401: {"model": ErrorDetail, "description": "The API key is missing, unknown or expired."},
}
MODEL_ERRORS: Responses = KEY_ERRORS | {
    403: {"model": ErrorDetail, "description": "The API key does not cover this model."},
    404: {"model": ErrorDetail, "description": "No model has this name."},
}
STREAMED: Responses = {
    200: {
        "model": ChatCompletion,
        "description": "The answer, or with stream set, server-sent chat.completion.chunk events.",
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    },
    400: {
        "model": OpenAIErrorBody,
        "description": "A field is out of range or cannot be applied to this model; param names it.",
    },
}
SERVED: Responses = {
    409: {"model": ErrorDetail, "description": "The version was trained on base weights that changed since."},
    503: {"model": ErrorDetail, "description": "No engine is serving this model right now."},
}
CHAT_RESPONSES: Responses = (
    STREAMED
    | MODEL_ERRORS
    | SERVED
    | {422: {"model": OpenAIErrorBody, "description": "The answer does not match response_format or the contract."}}
)
TEXT_RESPONSES: Responses = (
    STREAMED
    | {
        200: {
            "model": TextCompletion,
            "description": "The text, or with stream set, server-sent text_completion events.",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    }
    | MODEL_ERRORS
    | SERVED
)
FEEDBACK_RESPONSES: Responses = MODEL_ERRORS | {
    422: {"model": ErrorDetail, "description": "The model is a base model, or the body is not valid."},
}
