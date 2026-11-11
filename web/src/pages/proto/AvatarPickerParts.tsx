import { Check } from "lucide-react";
import { Badge, Input, Label, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { type AvatarChoice, AvatarTile, TONE_LABELS, sameChoice } from "./avatarDicebear";
import { RECENT_LIMIT, describe } from "./avatarSession";
import { TONE_KEYS, type ToneName, toneToken } from "./modelIcons";

const LETTERS_LIMIT = 2;
const TIP_DELAY = 350;

export type Peek = (choice: AvatarChoice | null) => void;

const PRESS_RING =
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function choiceKey(choice: AvatarChoice): string {
    return `${choice.style}-${choice.seed}-${choice.tone}-${choice.letters ?? ""}`;
}

function SelectedTick() {
    return (
        <span
            aria-hidden="true"
            className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-sm bg-primary text-primary-foreground"
        >
            <Check className="size-3" strokeWidth={3} />
        </span>
    );
}

function Figure({
    choice,
    name,
    caption,
}: {
    choice: AvatarChoice;
    name: string;
    caption: ReactNode;
}) {
    return (
        <figure className="flex min-w-0 flex-col items-center gap-3">
            <AvatarTile
                key={choiceKey(choice)}
                choice={choice}
                name={name}
                size="hero"
                className="avatar-fade"
            />
            <figcaption className="flex min-w-0 max-w-full flex-col items-center text-center">
                {caption}
                <span className="max-w-full text-sm text-balance text-muted-foreground">
                    {describe(choice, name)}
                </span>
            </figcaption>
        </figure>
    );
}

export function HeroStage({
    shown,
    saved,
    previewing,
    compare,
    name,
}: {
    shown: AvatarChoice;
    saved: AvatarChoice;
    previewing: boolean;
    compare: boolean;
    name: string;
}) {
    return (
        <section
            aria-label="Preview"
            data-testid="avatar-hero"
            className="relative flex min-w-0 items-center justify-center rounded-lg border bg-background px-4 pt-9 pb-5 sm:h-76"
        >
            <div className="absolute top-3 left-3 flex h-5 items-center">
                {previewing && !compare && <Badge variant="info">Preview</Badge>}
            </div>
            {compare ? (
                <div className="grid grid-cols-2 gap-3 [--hero-scale:2.5] sm:[--hero-scale:3.333]">
                    <Figure
                        choice={saved}
                        name={name}
                        caption={<span className="font-medium">Now</span>}
                    />
                    <Figure
                        choice={shown}
                        name={name}
                        caption={
                            <span className="font-medium">{previewing ? "Preview" : "New"}</span>
                        }
                    />
                </div>
            ) : (
                <div className="flex min-w-0 max-w-full [--hero-scale:2.5] sm:[--hero-scale:3.667]">
                    <Figure
                        choice={shown}
                        name={name}
                        caption={
                            <span className="max-w-full truncate text-lg font-medium">{name}</span>
                        }
                    />
                </div>
            )}
        </section>
    );
}

function ContextRow({
    size,
    caption,
    className,
    children,
}: {
    size: string;
    caption: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={cn("flex min-w-0 items-center gap-3 px-3", className)}>
            {children}
            <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">
                <span className="sr-only">{caption}, </span>
                {size}
            </span>
        </div>
    );
}

export function ContextStrip({ choice, name }: { choice: AvatarChoice; name: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <span className="text-sm text-muted-foreground">In the app</span>
            <div
                data-testid="avatar-previews"
                className="flex min-w-0 flex-col divide-y rounded-lg border bg-background"
            >
                <ContextRow size="48 px" caption="Page header" className="py-2.5">
                    <AvatarTile choice={choice} name={name} size="lg" />
                    <span className="min-w-0 truncate text-lg">{name}</span>
                </ContextRow>
                <ContextRow size="32 px" caption="Picker item" className="py-2">
                    <AvatarTile choice={choice} name={name} size="md" />
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate font-semibold">{name}</span>
                        <span className="truncate text-sm text-muted-foreground">
                            on Qwen3 0.6B
                        </span>
                    </span>
                </ContextRow>
                <ContextRow size="20 px" caption="List row" className="gap-2 py-2">
                    <AvatarTile choice={choice} name={name} size="sm" />
                    <span className="min-w-0 truncate">{name}</span>
                </ContextRow>
            </div>
        </div>
    );
}

function moveIndex(key: string, index: number, count: number, columns: number): number | null {
    const moves: Record<string, number> = {
        ArrowRight: index + 1,
        ArrowLeft: index - 1,
        ArrowDown: index + columns,
        ArrowUp: index - columns,
        Home: 0,
        End: count - 1,
    };
    const next = moves[key];
    return next === undefined ? null : Math.min(Math.max(next, 0), count - 1);
}

export function CandidateGrid({
    label,
    items,
    selected,
    name,
    dealt,
    onPeek,
    onSelect,
    onUse,
}: {
    label: string;
    items: AvatarChoice[];
    selected: AvatarChoice;
    name: string;
    dealt: number;
    onPeek: Peek;
    onSelect: (choice: AvatarChoice) => void;
    onUse: (choice: AvatarChoice) => void;
}) {
    const grid = useRef<HTMLDivElement>(null);
    const [focused, setFocused] = useState(-1);
    const current = items.findIndex((item) => sameChoice(item, selected));
    const roving = focused >= 0 && focused < items.length ? focused : Math.max(current, 0);
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (event.key === "Enter" && index === current) {
                onUse(items[index]);
            } else {
                onSelect(items[index]);
            }
            return;
        }
        const host = grid.current;
        const columns = host ? getComputedStyle(host).gridTemplateColumns.split(" ").length : 1;
        const next = moveIndex(event.key, index, items.length, columns);
        if (next === null || !host) {
            return;
        }
        event.preventDefault();
        host.querySelectorAll<HTMLElement>("[data-candidate]")[next]?.focus();
    };
    return (
        <fieldset className="min-w-0">
            <legend className="sr-only">{label}</legend>
            <div
                ref={grid}
                key={dealt}
                onPointerLeave={() => onPeek(null)}
                className="avatar-fade grid grid-cols-4 gap-2 sm:grid-cols-6"
            >
                {items.map((item, index) => {
                    const checked = index === current;
                    const text = describe(item, name);
                    return (
                        <Tooltip key={choiceKey(item)} delayDuration={TIP_DELAY}>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    data-candidate
                                    tabIndex={index === roving ? 0 : -1}
                                    aria-pressed={checked}
                                    aria-label={`${text}, ${index + 1} of ${items.length}`}
                                    onPointerEnter={() => onPeek(item)}
                                    onFocus={() => {
                                        setFocused(index);
                                        onPeek(item);
                                    }}
                                    onBlur={() => onPeek(null)}
                                    onClick={() => onSelect(item)}
                                    onDoubleClick={() => onUse(item)}
                                    onKeyDown={(event) => onKeyDown(event, index)}
                                    className={cn(
                                        "relative flex aspect-square w-full cursor-pointer items-center justify-center rounded-lg border border-transparent p-1.5 hover:bg-secondary",
                                        PRESS_RING,
                                        checked && "border-primary",
                                    )}
                                >
                                    <AvatarTile choice={item} name={name} size="fill" />
                                    {checked && <SelectedTick />}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{text}</TooltipContent>
                        </Tooltip>
                    );
                })}
            </div>
        </fieldset>
    );
}

export function ColourRow({
    tone,
    pinned,
    onPeek,
    onPick,
    onMix,
}: {
    tone: ToneName;
    pinned: boolean;
    onPeek: (tone: ToneName | null) => void;
    onPick: (tone: ToneName) => void;
    onMix: () => void;
}) {
    const group = useId();
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <div className="flex h-5 items-center gap-2">
                <span id={`${group}-label`} className="font-medium">
                    Colour
                </span>
                <span className="text-sm text-muted-foreground">{TONE_LABELS[tone]}</span>
                {pinned && (
                    <button
                        type="button"
                        onClick={onMix}
                        className="ml-auto rounded-sm text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        Mix colours
                    </button>
                )}
            </div>
            <div
                role="radiogroup"
                aria-labelledby={`${group}-label`}
                className="grid w-fit grid-cols-5 gap-1 sm:flex"
                onPointerLeave={() => onPeek(null)}
            >
                {TONE_KEYS.map((key) => {
                    const checked = key === tone;
                    return (
                        <Tooltip key={key} delayDuration={TIP_DELAY}>
                            <TooltipTrigger asChild>
                                <label
                                    onPointerEnter={() => onPeek(key)}
                                    className={cn(
                                        "flex size-8 cursor-pointer items-center justify-center rounded-md border border-transparent hover:border-input has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background",
                                        checked && "border-foreground hover:border-foreground",
                                    )}
                                >
                                    <input
                                        type="radio"
                                        name={group}
                                        checked={checked}
                                        onChange={() => onPick(key)}
                                        onFocus={() => onPeek(key)}
                                        onBlur={() => onPeek(null)}
                                        aria-label={TONE_LABELS[key]}
                                        className="sr-only"
                                    />
                                    <span
                                        aria-hidden="true"
                                        className="flex size-6 items-center justify-center rounded-sm text-background"
                                        style={{ backgroundColor: `var(${toneToken(key)})` }}
                                    >
                                        {checked && <Check className="size-4" strokeWidth={3} />}
                                    </span>
                                </label>
                            </TooltipTrigger>
                            <TooltipContent>{TONE_LABELS[key]}</TooltipContent>
                        </Tooltip>
                    );
                })}
            </div>
        </div>
    );
}

function lettersProblem(raw: string): string | null {
    if (/[^\p{L}\p{N}]/u.test(raw)) {
        return "Letters and numbers only.";
    }
    if (Array.from(raw).length > LETTERS_LIMIT) {
        return "Two at most, so it reads at 20 px.";
    }
    return null;
}

export function LettersField({
    letters,
    fallback,
    onChange,
}: {
    letters: string;
    fallback: string;
    onChange: (letters: string) => void;
}) {
    const [problem, setProblem] = useState<string | null>(null);
    const hint = useId();
    const message =
        problem ??
        (letters
            ? `Clear it to use ${fallback} from the name.`
            : `One or two. Blank uses ${fallback}.`);
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <Label htmlFor="avatar-letters" className="h-5">
                Letters
            </Label>
            <div className="flex min-w-0 items-center gap-3">
                <Input
                    id="avatar-letters"
                    value={letters}
                    placeholder={fallback}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={hint}
                    aria-invalid={problem !== null || undefined}
                    onChange={(event) => {
                        const raw = event.target.value;
                        setProblem(lettersProblem(raw));
                        onChange(
                            Array.from(raw.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase())
                                .slice(0, LETTERS_LIMIT)
                                .join(""),
                        );
                    }}
                    onBlur={() => setProblem(null)}
                    className="w-16 shrink-0 text-center font-medium uppercase"
                />
                <span
                    id={hint}
                    aria-live="polite"
                    className={cn(
                        "min-w-0 text-sm",
                        problem ? "text-foreground" : "text-muted-foreground",
                    )}
                >
                    {message}
                </span>
            </div>
        </div>
    );
}

export function RecentStrip({
    items,
    selected,
    name,
    onPeek,
    onSelect,
}: {
    items: AvatarChoice[];
    selected: AvatarChoice;
    name: string;
    onPeek: Peek;
    onSelect: (choice: AvatarChoice) => void;
}) {
    const empty = Math.max(RECENT_LIMIT - items.length, 0);
    return (
        <section
            aria-label="Recent"
            className="flex min-w-0 flex-col gap-label border-t pt-4 lg:mt-auto"
        >
            <div className="flex h-5 items-center gap-2">
                <span className="font-medium">Recent</span>
                <span className="text-sm text-muted-foreground">
                    Up to {RECENT_LIMIT}, newest first
                </span>
            </div>
            <ul className="flex items-center gap-1.5" onPointerLeave={() => onPeek(null)}>
                {items.map((item) => {
                    const checked = sameChoice(item, selected);
                    const text = describe(item, name);
                    return (
                        <li key={choiceKey(item)}>
                            <Tooltip delayDuration={TIP_DELAY}>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        aria-pressed={checked}
                                        aria-label={`Recent: ${text}`}
                                        onPointerEnter={() => onPeek(item)}
                                        onFocus={() => onPeek(item)}
                                        onBlur={() => onPeek(null)}
                                        onClick={() => onSelect(item)}
                                        className={cn(
                                            "relative flex size-10 items-center justify-center rounded-md border border-transparent p-0.5 hover:bg-secondary",
                                            PRESS_RING,
                                            checked && "border-primary",
                                        )}
                                    >
                                        <AvatarTile choice={item} name={name} size="fill" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>{text}</TooltipContent>
                            </Tooltip>
                        </li>
                    );
                })}
                {Array.from({ length: empty }, (_, offset) => items.length + offset).map((slot) => (
                    <li
                        key={`slot-${slot}`}
                        aria-hidden="true"
                        className="size-10 rounded-md border border-dashed"
                    />
                ))}
            </ul>
        </section>
    );
}
