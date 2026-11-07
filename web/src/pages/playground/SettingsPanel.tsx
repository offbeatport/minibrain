import { X } from "lucide-react";
import {
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    InfoTip,
    Input,
    JsonEditor,
    Label,
    OptionalNumberField,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { ModelLabel } from "~/components/PublisherLogo";
import {
    DEFAULT_PARAMETERS,
    type FunctionSpec,
    type Guard,
    type ResponseFormat,
    type Settings,
    type Target,
    jsonProblem,
    newId,
    reasoningOptions,
} from "~/lib/playground";
import { Presets } from "./Presets";

const MODEL_DEFAULT = "default";
const NONE = "none";
const MAX_STOPS = 4;
const TOKEN_CAP = 32768;
const WHOLE = { maximumFractionDigits: 0 };
const TWO = { maximumFractionDigits: 2 };

type Change = (next: Partial<Settings>) => void;

function Group({
    title,
    children,
    open = true,
}: { title: string; children: ReactNode; open?: boolean }) {
    return (
        <Collapsible defaultOpen={open} className="border-b px-4 py-3 last:border-b-0">
            <CollapsibleTrigger className="w-full font-medium">{title}</CollapsibleTrigger>
            <CollapsibleContent>
                <div className="flex flex-col gap-4 pt-3">{children}</div>
            </CollapsibleContent>
        </Collapsible>
    );
}

function Labelled({
    id,
    label,
    help,
    children,
}: { id: string | null; label: string; help: ReactNode; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-label">
            <div className="flex items-center gap-1.5">
                {id ? (
                    <Label htmlFor={id}>{label}</Label>
                ) : (
                    <span className="leading-snug font-medium">{label}</span>
                )}
                <InfoTip label={`About ${label}`}>{help}</InfoTip>
            </div>
            {children}
        </div>
    );
}

function Note({ children }: { children: ReactNode }) {
    return <p className="text-sm text-muted-foreground">{children}</p>;
}

function targetLabel(target: Target): string {
    if (target.kind === "base") {
        return target.model_name;
    }
    return target.live
        ? `${target.model_name} · live`
        : `${target.model_name} · v${target.version}`;
}

function ModelPicker({
    targets,
    model,
    onModel,
}: {
    targets: Target[];
    model: string;
    onModel: (name: string) => void;
}) {
    const custom = targets.filter((item) => item.kind === "custom");
    const bases = targets.filter((item) => item.kind === "base");
    return (
        <Labelled
            id="playground-model"
            label="Model"
            help="Any version of your models, the live one by name, or any base on this install, deployed or not."
        >
            <Select value={model} onValueChange={(next) => onModel(String(next ?? model))}>
                <SelectTrigger id="playground-model" className="w-full">
                    <SelectValue>
                        {(value: string | null) => {
                            const found = targets.find((item) => item.name === value);
                            return found ? (
                                <ModelLabel
                                    publisher={found.publisher}
                                    name={found.model_name}
                                    label={targetLabel(found)}
                                />
                            ) : (
                                "Pick a model"
                            );
                        }}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {custom.length > 0 && (
                        <SelectGroup>
                            <SelectLabel>Your models</SelectLabel>
                            {custom.map((item) => (
                                <SelectItem
                                    key={item.name}
                                    value={item.name}
                                    label={targetLabel(item)}
                                >
                                    <ModelLabel
                                        publisher={item.publisher}
                                        name={item.model_name}
                                        label={targetLabel(item)}
                                        detail={<span className="font-mono">{item.name}</span>}
                                    />
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    )}
                    {bases.length > 0 && (
                        <SelectGroup>
                            <SelectLabel>Base models</SelectLabel>
                            {bases.map((item) => (
                                <SelectItem
                                    key={item.name}
                                    value={item.name}
                                    label={targetLabel(item)}
                                >
                                    <ModelLabel
                                        publisher={item.publisher}
                                        name={item.model_name}
                                        label={targetLabel(item)}
                                        detail={
                                            item.deployed ? "Deployed" : "Installed, not deployed"
                                        }
                                    />
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    )}
                </SelectContent>
            </Select>
        </Labelled>
    );
}

function SafetyControls({
    target,
    guards,
    settings,
    onChange,
}: {
    target: Target | undefined;
    guards: Guard[];
    settings: Settings;
    onChange: Change;
}) {
    const enforced = target?.safety ?? null;
    const value = enforced ?? settings.safety_model ?? NONE;
    const answers = Boolean(target?.safety_answers) || settings.safety_answers;
    const name = (key: string) => guards.find((guard) => guard.key === key)?.name ?? key;
    return (
        <Labelled
            id="playground-safety"
            label="Safety model"
            help="A guard model that checks your message before the model answers, and its answer too if you ask. A blocked call returns a refusal with the categories it found. None by default."
        >
            <Select
                value={value}
                disabled={Boolean(enforced)}
                onValueChange={(next) =>
                    onChange({ safety_model: !next || next === NONE ? null : String(next) })
                }
            >
                <SelectTrigger id="playground-safety" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {enforced && !guards.some((guard) => guard.key === enforced) && (
                        <SelectItem value={enforced}>{name(enforced)}</SelectItem>
                    )}
                    {guards.map((guard) => (
                        <SelectItem key={guard.key} value={guard.key}>
                            {guard.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {enforced && (
                <Note>
                    Set for this model in Settings or on its Deployments page; a request cannot
                    change it.
                </Note>
            )}
            {!enforced && guards.length === 0 && (
                <Note>No safety model is installed; Discover lists them under Safety.</Note>
            )}
            {value !== NONE && (
                <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="playground-safety-answers">Also check answers</Label>
                    <Switch
                        id="playground-safety-answers"
                        checked={answers}
                        disabled={Boolean(target?.safety_answers)}
                        onCheckedChange={(checked) => onChange({ safety_answers: checked })}
                    />
                </div>
            )}
        </Labelled>
    );
}

function ReasoningControl({
    target,
    settings,
    onChange,
}: { target: Target | undefined; settings: Settings; onChange: Change }) {
    const options = reasoningOptions(target);
    const fixed = target?.reasoning === "always";
    const explain = !target
        ? null
        : target.contract !== "text"
          ? "This model answers with its contract, so it does not reason."
          : fixed
            ? "This model always reasons; it has no setting."
            : options.length === 0
              ? "This model does not reason."
              : null;
    return (
        <Labelled
            id="playground-reasoning"
            label="Reasoning"
            help="Whether the model thinks before it answers, and how hard, where its family supports it: Qwen3 thinks or not, gpt-oss takes an effort. The reasoning shows apart from the answer. Model default leaves it to the model."
        >
            <Select
                value={settings.reasoning ?? MODEL_DEFAULT}
                disabled={options.length === 0}
                onValueChange={(next) =>
                    onChange({ reasoning: !next || next === MODEL_DEFAULT ? null : String(next) })
                }
            >
                <SelectTrigger id="playground-reasoning" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={MODEL_DEFAULT}>
                        {fixed ? "Always on" : "Model default"}
                    </SelectItem>
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {explain && <Note>{explain}</Note>}
        </Labelled>
    );
}

function contractNote(target: Target | undefined): string | null {
    if (target?.contract === "labels") {
        return "This model answers with one of its labels, its contract; formats and functions do not apply.";
    }
    if (target?.contract === "json") {
        return "This model answers with its own JSON schema, its contract; formats and functions do not apply.";
    }
    return null;
}

function FormatControl({
    target,
    settings,
    onChange,
}: { target: Target | undefined; settings: Settings; onChange: Change }) {
    const locked = target !== undefined && target.contract !== "text";
    const problem =
        settings.response_format === "json_schema" ? jsonProblem(settings.schema) : null;
    return (
        <Labelled
            id="playground-format"
            label="Response format"
            help="Text leaves the answer free. JSON object makes it a JSON object; JSON schema holds it to your schema. SGLang and llama.cpp constrain while generating; other engines check the answer after, and a mismatch is an error."
        >
            <Select
                value={settings.response_format}
                disabled={locked}
                onValueChange={(next) =>
                    onChange({ response_format: (next as ResponseFormat) ?? "text" })
                }
            >
                <SelectTrigger id="playground-format" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="json_object">JSON object</SelectItem>
                    <SelectItem value="json_schema">JSON schema</SelectItem>
                </SelectContent>
            </Select>
            {settings.response_format === "json_schema" && !locked && (
                <>
                    <Input
                        aria-label="Schema name"
                        value={settings.schema_name}
                        onChange={(event) => onChange({ schema_name: event.target.value })}
                        placeholder="Schema name"
                    />
                    <JsonEditor
                        aria-label="JSON schema"
                        value={settings.schema}
                        onValueChange={(schema) => onChange({ schema })}
                        minLines={6}
                        maxLines={16}
                        aria-invalid={problem !== null}
                    />
                    {problem && <p className="text-sm text-destructive">{problem}</p>}
                </>
            )}
        </Labelled>
    );
}

function FunctionEditor({
    spec,
    onChange,
    onRemove,
}: {
    spec: FunctionSpec;
    onChange: (next: FunctionSpec) => void;
    onRemove: () => void;
}) {
    const problem = jsonProblem(spec.parameters);
    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
                <Input
                    aria-label="Function name"
                    value={spec.name}
                    placeholder="get_weather"
                    className="font-mono"
                    onChange={(event) => onChange({ ...spec, name: event.target.value })}
                />
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Remove function"
                            onClick={onRemove}
                        >
                            <X />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove function</TooltipContent>
                </Tooltip>
            </div>
            <Input
                aria-label="Function description"
                value={spec.description}
                placeholder="What it does, for the model"
                onChange={(event) => onChange({ ...spec, description: event.target.value })}
            />
            <JsonEditor
                aria-label="Parameters as JSON schema"
                value={spec.parameters}
                onValueChange={(parameters) => onChange({ ...spec, parameters })}
                minLines={4}
                maxLines={14}
                aria-invalid={problem !== null}
            />
            {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
    );
}

function FunctionsControl({
    target,
    settings,
    onChange,
}: { target: Target | undefined; settings: Settings; onChange: Change }) {
    const unsupported = target !== undefined && target.contract === "text" && !target.tools;
    const locked = target !== undefined && (target.contract !== "text" || !target.tools);
    const update = (functions: FunctionSpec[]) => {
        const names = new Set(functions.map((item) => item.name.trim()));
        const choice =
            ["auto", "none", "required"].includes(settings.tool_choice) ||
            names.has(settings.tool_choice);
        onChange({ functions, tool_choice: choice ? settings.tool_choice : "auto" });
    };
    const named = settings.functions.map((item) => item.name.trim()).filter(Boolean);
    return (
        <Labelled
            id={null}
            label="Functions"
            help="Tools the model may call. It answers with a call and its arguments; paste the result into the chat to let it continue. Each family's chat template renders them (Qwen, Llama 3.1 and later, Mistral, gpt-oss)."
        >
            {unsupported && (
                <Note>This base has no tool-call format minibrain reads in its chat template.</Note>
            )}
            {!locked &&
                settings.functions.map((spec, index) => (
                    <FunctionEditor
                        key={spec.id}
                        spec={spec}
                        onChange={(next) =>
                            update(
                                settings.functions.map((item, at) => (at === index ? next : item)),
                            )
                        }
                        onRemove={() => update(settings.functions.filter((_, at) => at !== index))}
                    />
                ))}
            <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={locked}
                onClick={() =>
                    update([
                        ...settings.functions,
                        { id: newId(), name: "", description: "", parameters: DEFAULT_PARAMETERS },
                    ])
                }
            >
                Add function
            </Button>
            {!locked && settings.functions.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="playground-tool-choice">Tool choice</Label>
                    <Select
                        value={settings.tool_choice}
                        onValueChange={(next) => onChange({ tool_choice: String(next ?? "auto") })}
                    >
                        <SelectTrigger id="playground-tool-choice" className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="required">Required</SelectItem>
                            {named.map((name) => (
                                <SelectItem key={name} value={name}>
                                    <span className="font-mono">{name}</span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
        </Labelled>
    );
}

function StopControl({ settings, onChange }: { settings: Settings; onChange: Change }) {
    const [draft, setDraft] = useState("");
    const add = () => {
        if (draft && settings.stop.length < MAX_STOPS && !settings.stop.includes(draft)) {
            onChange({ stop: [...settings.stop, draft] });
            setDraft("");
        }
    };
    return (
        <Labelled
            id="playground-stop"
            label="Stop sequences"
            help={`Up to ${MAX_STOPS} texts that end the answer when the model writes them; they are not returned. Unset: the model's own stop tokens only.`}
        >
            <div className="flex gap-2">
                <Input
                    id="playground-stop"
                    value={draft}
                    placeholder={settings.stop.length ? "Add another" : "Unset"}
                    disabled={settings.stop.length >= MAX_STOPS}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
                <Button
                    variant="outline"
                    onClick={add}
                    disabled={!draft || settings.stop.length >= MAX_STOPS}
                >
                    Add
                </Button>
            </div>
            {settings.stop.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {settings.stop.map((text) => (
                        <span
                            key={text}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-sm"
                        >
                            {JSON.stringify(text)}
                            <button
                                type="button"
                                aria-label={`Remove stop ${text}`}
                                className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() =>
                                    onChange({
                                        stop: settings.stop.filter((item) => item !== text),
                                    })
                                }
                            >
                                <X className="size-3.5" aria-hidden="true" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </Labelled>
    );
}

export function SettingsPanel({
    targets,
    guards,
    target,
    model,
    onModel,
    settings,
    onSettings,
    preset,
    onPreset,
}: {
    targets: Target[];
    guards: Guard[];
    target: Target | undefined;
    model: string;
    onModel: (name: string) => void;
    settings: Settings;
    onSettings: (next: Settings) => void;
    preset: number | null;
    onPreset: (id: number | null) => void;
}) {
    const change: Change = (next) => onSettings({ ...settings, ...next });
    const note = contractNote(target);
    const limit = target?.context_tokens ?? TOKEN_CAP;
    return (
        <div className="flex flex-col">
            <div className="flex flex-col gap-4 border-b px-4 py-3">
                <ModelPicker targets={targets} model={model} onModel={onModel} />
                {note && <Note>{note}</Note>}
            </div>
            <Group title="Presets">
                <Presets
                    settings={settings}
                    onLoad={onSettings}
                    chosen={preset}
                    onChosen={onPreset}
                />
            </Group>
            <Group title="Settings">
                <OptionalNumberField
                    id="playground-max-tokens"
                    label="Max tokens"
                    help={`The most tokens the answer may use. Unset means the model's limit${target?.context_tokens ? `, ${target.context_tokens.toLocaleString()} tokens of context for this one` : ""}.`}
                    value={settings.max_tokens}
                    onValueChange={(max_tokens) => change({ max_tokens })}
                    min={1}
                    max={limit}
                    step={1}
                    largeStep={256}
                    fallback={Math.min(1024, limit)}
                    format={WHOLE}
                />
                <OptionalNumberField
                    id="playground-temperature"
                    label="Temperature"
                    help="How varied the answer is, from 0 (the likeliest token every time) to 2. Unset keeps the model's default; your custom models answer at 0, the way they were scored."
                    value={settings.temperature}
                    onValueChange={(temperature) => change({ temperature })}
                    min={0}
                    max={2}
                    step={0.01}
                    largeStep={0.1}
                    fallback={0.7}
                    format={TWO}
                />
                <SafetyControls
                    target={target}
                    guards={guards}
                    settings={settings}
                    onChange={change}
                />
                <ReasoningControl target={target} settings={settings} onChange={change} />
            </Group>
            <Group title="Format options">
                <FormatControl target={target} settings={settings} onChange={change} />
                <FunctionsControl target={target} settings={settings} onChange={change} />
            </Group>
            <Group title="Sampling" open={false}>
                <OptionalNumberField
                    id="playground-top-p"
                    label="Top P"
                    help="Sample only from the likeliest tokens whose probabilities add up to this share. Unset keeps the model's default."
                    value={settings.top_p}
                    onValueChange={(top_p) => change({ top_p })}
                    min={0.01}
                    max={1}
                    step={0.01}
                    fallback={0.9}
                    format={TWO}
                />
                <OptionalNumberField
                    id="playground-top-k"
                    label="Top K"
                    help="Sample only from this many of the likeliest tokens. An engine extension; unset keeps the model's default."
                    value={settings.top_k}
                    onValueChange={(top_k) => change({ top_k })}
                    min={1}
                    max={200}
                    step={1}
                    fallback={40}
                    format={WHOLE}
                />
                <OptionalNumberField
                    id="playground-min-p"
                    label="Min P"
                    help="Drop tokens less likely than this share of the likeliest one. An engine extension; unset keeps the model's default."
                    value={settings.min_p}
                    onValueChange={(min_p) => change({ min_p })}
                    min={0}
                    max={1}
                    step={0.01}
                    fallback={0.05}
                    format={TWO}
                />
                <OptionalNumberField
                    id="playground-presence"
                    label="Presence penalty"
                    help="Above 0 favours tokens that have not appeared yet, so the answer moves to new topics; below 0 does the opposite. Unset: 0."
                    value={settings.presence_penalty}
                    onValueChange={(presence_penalty) => change({ presence_penalty })}
                    min={-2}
                    max={2}
                    step={0.1}
                    fallback={0}
                    format={TWO}
                />
                <OptionalNumberField
                    id="playground-frequency"
                    label="Frequency penalty"
                    help="Above 0 lowers a token's odds the more often it has appeared, so the answer repeats itself less. Unset: 0."
                    value={settings.frequency_penalty}
                    onValueChange={(frequency_penalty) => change({ frequency_penalty })}
                    min={-2}
                    max={2}
                    step={0.1}
                    fallback={0}
                    format={TWO}
                />
                <OptionalNumberField
                    id="playground-repetition"
                    label="Repetition penalty"
                    help="Above 1 discourages repeating any token seen so far, prompt included; 1 changes nothing. An engine extension; unset keeps the model's default."
                    value={settings.repetition_penalty}
                    onValueChange={(repetition_penalty) => change({ repetition_penalty })}
                    min={0.1}
                    max={2}
                    step={0.01}
                    fallback={1.1}
                    format={TWO}
                />
                <StopControl settings={settings} onChange={change} />
                <OptionalNumberField
                    id="playground-seed"
                    label="Seed"
                    help="The same seed and inputs sample the same way, as far as the engine allows. Unset samples freshly each time."
                    value={settings.seed}
                    onValueChange={(seed) => change({ seed })}
                    min={0}
                    max={2147483647}
                    step={1}
                    slider={false}
                    fallback={42}
                    format={WHOLE}
                />
            </Group>
        </div>
    );
}
