import { Check, Dices } from "lucide-react";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Kbd,
    KbdHint,
    Label,
    Tabs,
    TabsList,
    TabsTrigger,
    cn,
} from "obp-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import "./avatarPicker.css";
import {
    type AvatarChoice,
    AvatarTile,
    TONE_LABELS,
    candidateChoices,
    defaultLetters,
    sameChoice,
} from "./avatarDicebear";
import { AVATAR_STYLES, type AvatarStyleId, styleById } from "./avatarStyles";
import { TONE_KEYS, type ToneName, toneToken } from "./modelIcons";

const GRID_SIZE = 12;
const RECENT_LIMIT = 6;
const LETTERS_LIMIT = 2;

let remembered: AvatarChoice[] = [];

type ByStyle<T> = Record<AvatarStyleId, T>;

type Session = {
    tab: AvatarStyleId;
    pin: ToneName | null;
    letters: string;
    batches: ByStyle<AvatarChoice[]>;
    selected: ByStyle<AvatarChoice>;
    deal: number;
    recent: AvatarChoice[];
};

function withRecent(list: AvatarChoice[], choice: AvatarChoice): AvatarChoice[] {
    return [choice, ...list.filter((item) => !sameChoice(item, choice))].slice(0, RECENT_LIMIT);
}

function byStyle<T>(make: (id: AvatarStyleId) => T): ByStyle<T> {
    return Object.fromEntries(
        AVATAR_STYLES.map((style) => [style.id, make(style.id)]),
    ) as ByStyle<T>;
}

function startSession(value: AvatarChoice): Session {
    const letters = value.letters ?? "";
    const batches = byStyle((id) => {
        const batch = candidateChoices(id, GRID_SIZE, null, letters || undefined);
        if (!styleById(id).seeded) {
            return batch;
        }
        const [first, ...rest] = batch;
        return [id === value.style ? value : { ...first, tone: value.tone }, ...rest];
    });
    const selected = byStyle((id) =>
        id === value.style
            ? value
            : styleById(id).seeded
              ? batches[id][0]
              : { style: id, seed: "initials", tone: value.tone, letters: letters || undefined },
    );
    return {
        tab: value.style,
        pin: null,
        letters,
        batches,
        selected,
        deal: 0,
        recent: [value, ...remembered.filter((item) => !sameChoice(item, value))].slice(
            0,
            RECENT_LIMIT,
        ),
    };
}

function recolour(session: Session, tone: ToneName): Session {
    return {
        ...session,
        pin: tone,
        batches: byStyle((id) =>
            styleById(id).seeded
                ? session.batches[id].map((choice) => ({ ...choice, tone }))
                : session.batches[id],
        ),
        selected: byStyle((id) => ({ ...session.selected[id], tone })),
    };
}

function mixColours(session: Session): Session {
    return {
        ...session,
        pin: null,
        batches: byStyle((id) =>
            styleById(id).seeded
                ? session.batches[id].map((choice, index) =>
                      choice.seed === session.selected[id].seed
                          ? choice
                          : { ...choice, tone: TONE_KEYS[(index * 3) % TONE_KEYS.length] },
                  )
                : session.batches[id],
        ),
    };
}

function withLetters(session: Session, letters: string): Session {
    const value = letters || undefined;
    return {
        ...session,
        letters,
        batches: {
            ...session.batches,
            initials: session.batches.initials.map((c) => ({ ...c, letters: value })),
        },
        selected: {
            ...session.selected,
            initials: { ...session.selected.initials, letters: value },
        },
    };
}

function deal(session: Session): Session {
    const tab = session.tab;
    if (!styleById(tab).seeded) {
        return session;
    }
    return {
        ...session,
        recent: withRecent(session.recent, session.selected[tab]),
        batches: { ...session.batches, [tab]: candidateChoices(tab, GRID_SIZE, session.pin) },
        deal: session.deal + 1,
    };
}

function choose(session: Session, choice: AvatarChoice): Session {
    if (!styleById(choice.style).seeded) {
        return recolour({ ...session, tab: choice.style }, choice.tone);
    }
    return {
        ...session,
        tab: choice.style,
        selected: { ...session.selected, [choice.style]: choice },
    };
}

function finalChoice(choice: AvatarChoice): AvatarChoice {
    const { letters, ...rest } = choice;
    return styleById(choice.style).seeded || !letters ? rest : { ...rest, letters };
}

export function isTyping(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
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

function CandidateGrid({
    label,
    items,
    selected,
    name,
    dealt,
    onSelect,
    onUse,
}: {
    label: string;
    items: AvatarChoice[];
    selected: AvatarChoice;
    name: string;
    dealt: number;
    onSelect: (choice: AvatarChoice) => void;
    onUse: (choice: AvatarChoice) => void;
}) {
    const grid = useRef<HTMLDivElement>(null);
    const group = useId();
    const current = items.findIndex((item) => sameChoice(item, selected));
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
        if (event.key === "Enter") {
            event.preventDefault();
            onUse(items[index]);
            return;
        }
        const host = grid.current;
        const columns = host ? getComputedStyle(host).gridTemplateColumns.split(" ").length : 1;
        const next = moveIndex(event.key, index, items.length, columns);
        if (next === null || !host) {
            return;
        }
        event.preventDefault();
        host.querySelectorAll<HTMLInputElement>("input[type=radio]")[next]?.focus();
        onSelect(items[next]);
    };
    return (
        <fieldset className="min-w-0">
            <legend className="sr-only">{label}</legend>
            <div
                ref={grid}
                key={dealt}
                className={cn(
                    "avatar-fade grid gap-2",
                    items.length > TONE_KEYS.length
                        ? "grid-cols-4 sm:max-w-[26.5rem] sm:grid-cols-6"
                        : "max-w-[22rem] grid-cols-5",
                )}
            >
                {items.map((item, index) => {
                    const checked = index === current;
                    return (
                        <label
                            key={`${item.seed}-${item.tone}`}
                            onDoubleClick={() => onUse(item)}
                            className={cn(
                                "flex aspect-square w-full cursor-pointer items-center justify-center rounded-lg border border-transparent hover:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background",
                                checked &&
                                    "border-primary bg-accent ring-1 ring-primary ring-inset hover:bg-accent",
                            )}
                        >
                            <input
                                type="radio"
                                name={group}
                                checked={checked}
                                onChange={() => onSelect(item)}
                                onKeyDown={(event) => onKeyDown(event, index)}
                                aria-label={`${label} ${index + 1}, ${TONE_LABELS[item.tone]}`}
                                className="sr-only"
                            />
                            <AvatarTile choice={item} name={name} size="lg" />
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}

function ColourRow({
    tone,
    pinned,
    onPick,
    onMix,
}: {
    tone: ToneName;
    pinned: boolean;
    onPick: (tone: ToneName) => void;
    onMix: () => void;
}) {
    return (
        <div className="flex flex-col gap-label">
            <div className="flex h-5 items-center justify-between gap-3">
                <span aria-hidden="true" className="font-medium">
                    Colour
                </span>
                <span className="text-sm text-muted-foreground">
                    {pinned ? (
                        <button
                            type="button"
                            onClick={onMix}
                            className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            Mix colours
                        </button>
                    ) : (
                        TONE_LABELS[tone]
                    )}
                </span>
            </div>
            <fieldset className="grid w-fit grid-cols-5 gap-1.5 sm:flex sm:flex-wrap">
                <legend className="sr-only">Colour</legend>
                {TONE_KEYS.map((key) => {
                    const checked = key === tone;
                    return (
                        <label
                            key={key}
                            title={TONE_LABELS[key]}
                            className={cn(
                                "flex size-8 cursor-pointer items-center justify-center rounded-md border border-transparent hover:border-input has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background",
                                checked && "border-foreground hover:border-foreground",
                            )}
                        >
                            <input
                                type="radio"
                                name="avatar-colour"
                                checked={checked}
                                onChange={() => onPick(key)}
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
                    );
                })}
            </fieldset>
        </div>
    );
}

function LettersField({
    letters,
    fallback,
    onChange,
}: {
    letters: string;
    fallback: string;
    onChange: (letters: string) => void;
}) {
    return (
        <div className="flex flex-col gap-label">
            <Label htmlFor="avatar-letters">Letters</Label>
            <div className="flex items-center gap-2">
                <Input
                    id="avatar-letters"
                    value={letters}
                    placeholder={fallback}
                    maxLength={LETTERS_LIMIT}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                        onChange(
                            event.target.value
                                .replace(/[^\p{L}\p{N}]/gu, "")
                                .toUpperCase()
                                .slice(0, LETTERS_LIMIT),
                        )
                    }
                    className="w-20 font-medium uppercase"
                />
                <span className="text-sm text-muted-foreground">
                    {letters ? (
                        <button
                            type="button"
                            onClick={() => onChange("")}
                            className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            Use {fallback} from the name
                        </button>
                    ) : (
                        "One or two, from the name until you type."
                    )}
                </span>
            </div>
        </div>
    );
}

function RecentStrip({
    items,
    selected,
    name,
    onSelect,
}: {
    items: AvatarChoice[];
    selected: AvatarChoice;
    name: string;
    onSelect: (choice: AvatarChoice) => void;
}) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm text-muted-foreground">Recent</span>
            <ul className="flex min-w-0 flex-wrap items-center gap-1">
                {items.map((item, index) => {
                    const checked = sameChoice(item, selected);
                    return (
                        <li key={`${item.style}-${item.seed}-${item.tone}-${item.letters ?? ""}`}>
                            <button
                                type="button"
                                aria-pressed={checked}
                                aria-label={`Recent ${index + 1}: ${styleById(item.style).name}, ${TONE_LABELS[item.tone]}`}
                                onClick={() => onSelect(item)}
                                className={cn(
                                    "flex size-9 items-center justify-center rounded-md border border-transparent outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                    checked &&
                                        "border-primary bg-accent ring-1 ring-primary ring-inset hover:bg-accent",
                                )}
                            >
                                <AvatarTile choice={item} name={name} size="md" />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
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

function InContext({ choice, name }: { choice: AvatarChoice; name: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label self-start">
            <span className="text-sm text-muted-foreground">In context</span>
            <div
                data-testid="avatar-previews"
                className="flex min-w-0 flex-col divide-y rounded-lg border bg-background"
            >
                <ContextRow size="48 px" caption="Page header" className="py-3">
                    <AvatarTile choice={choice} name={name} size="lg" />
                    <span className="min-w-0 truncate text-lg">{name}</span>
                </ContextRow>
                <ContextRow size="32 px" caption="Picker item" className="py-2.5">
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

export function PickerDialog({
    open,
    onOpenChange,
    name,
    value,
    onUse,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    value: AvatarChoice;
    onUse: (choice: AvatarChoice) => void;
}) {
    const [session, setSession] = useState(() => startSession(value));
    const displayName = name.trim() || "Untitled model";
    const style = styleById(session.tab);
    const draft = session.selected[session.tab];
    const use = (choice: AvatarChoice) => {
        const picked = finalChoice(choice);
        remembered = withRecent(remembered, picked);
        onUse(picked);
        onOpenChange(false);
    };
    const shuffle = () => setSession(deal);
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (
                event.key.toLowerCase() === "r" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !isTyping(event.target)
            ) {
                event.preventDefault();
                setSession(deal);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (next) {
                    setSession(startSession(value));
                }
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Avatar</DialogTitle>
                    <DialogDescription>
                        For {displayName}. Click one to preview it; shuffle for more.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-6">
                    <Tabs
                        value={session.tab}
                        onValueChange={(tab) =>
                            setSession((previous) => ({ ...previous, tab: tab as AvatarStyleId }))
                        }
                    >
                        <TabsList
                            variant="line"
                            aria-label="Style"
                            className="w-full justify-start gap-0 border-b"
                        >
                            {AVATAR_STYLES.map((item) => (
                                <TabsTrigger
                                    key={item.id}
                                    value={item.id}
                                    className="flex-none gap-2 px-2 sm:px-3"
                                >
                                    <AvatarTile
                                        choice={session.selected[item.id]}
                                        name={displayName}
                                        size="sm"
                                        className="hidden sm:flex"
                                    />
                                    {item.name}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                    </Tabs>
                    <div className="grid min-w-0 gap-6 sm:grid-cols-[minmax(0,1fr)_17rem]">
                        <div className="flex min-w-0 flex-col gap-5">
                            <CandidateGrid
                                label={style.seeded ? style.name : `${style.name} colour`}
                                items={session.batches[session.tab]}
                                selected={draft}
                                name={displayName}
                                dealt={session.deal}
                                onSelect={(choice) =>
                                    setSession((previous) => choose(previous, choice))
                                }
                                onUse={use}
                            />
                            {style.seeded ? (
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                                    <Button type="button" variant="outline" onClick={shuffle}>
                                        <Dices aria-hidden="true" />
                                        Shuffle
                                        <Kbd className="hidden sm:inline-flex">R</Kbd>
                                    </Button>
                                    <RecentStrip
                                        items={session.recent}
                                        selected={draft}
                                        name={displayName}
                                        onSelect={(choice) =>
                                            setSession((previous) => choose(previous, choice))
                                        }
                                    />
                                </div>
                            ) : (
                                <LettersField
                                    letters={session.letters}
                                    fallback={defaultLetters(displayName)}
                                    onChange={(letters) =>
                                        setSession((previous) => withLetters(previous, letters))
                                    }
                                />
                            )}
                            {style.seeded && (
                                <ColourRow
                                    tone={draft.tone}
                                    pinned={session.pin !== null}
                                    onPick={(tone) =>
                                        setSession((previous) => recolour(previous, tone))
                                    }
                                    onMix={() => setSession(mixColours)}
                                />
                            )}
                        </div>
                        <InContext choice={draft} name={displayName} />
                    </div>
                </div>
                <DialogFooter className="sm:items-center">
                    <div className="mr-auto hidden flex-wrap gap-x-4 gap-y-1 sm:flex">
                        <KbdHint keys={["←", "↑", "→", "↓"]}>move</KbdHint>
                        <KbdHint keys={["Enter"]}>use</KbdHint>
                    </div>
                    <DialogClose render={<Button variant="outline">Cancel</Button>} />
                    <Button type="button" onClick={() => use(draft)}>
                        Use avatar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
