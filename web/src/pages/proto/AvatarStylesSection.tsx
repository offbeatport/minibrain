import {
    Badge,
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useMemo, useState } from "react";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Section } from "~/components/Section";
import {
    type AvatarChoice,
    type AvatarSize,
    AvatarTile,
    TONE_LABELS,
    type ThemeMode,
    baseSeed,
    choiceFor,
    modePalette,
    randomSeed,
    seedTone,
    usePalette,
} from "./avatarDicebear";
import { AVATAR_STYLES, type AvatarStyle, contrast, styleById } from "./avatarStyles";
import { MODELS, type SampleModel, TONE_KEYS, type ToneName, toneToken } from "./modelIcons";

const SIZES: Exclude<AvatarSize, "xl">[] = ["lg", "md", "sm"];

function Strip({ style }: { style: AvatarStyle }) {
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {MODELS.map((model) => {
                const choice = choiceFor(style.id, model.name);
                return (
                    <div
                        key={model.name}
                        className="flex min-w-0 flex-col gap-2 rounded-md border bg-background p-3"
                    >
                        <div className="flex items-end gap-3">
                            {SIZES.map((size) => (
                                <AvatarTile
                                    key={size}
                                    choice={choice}
                                    name={model.name}
                                    size={size}
                                />
                            ))}
                        </div>
                        <span className="truncate text-sm text-muted-foreground">{model.name}</span>
                    </div>
                );
            })}
        </div>
    );
}

function Shuffles({ style }: { style: AvatarStyle }) {
    const model = MODELS[0];
    const base = baseSeed(model.name);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">
                Shuffle: three seeds of {model.name}
            </span>
            <div className="flex items-end gap-3 rounded-lg border bg-background p-4">
                {[base, `${base}-1`, `${base}-2`].map((seed) => (
                    <span key={seed} className="flex flex-col items-center gap-2">
                        <AvatarTile
                            choice={choiceFor(style.id, model.name, seed)}
                            name={model.name}
                            size="lg"
                        />
                        <span className="font-mono text-sm text-muted-foreground">{seed}</span>
                    </span>
                ))}
            </div>
        </div>
    );
}

function ListMock({ style }: { style: AvatarStyle }) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">Models list</span>
            <div className="divide-y rounded-lg border bg-card">
                {MODELS.slice(0, 3).map((model) => (
                    <div key={model.name} className="flex items-center gap-3 px-4 py-3">
                        <AvatarTile
                            choice={choiceFor(style.id, model.name)}
                            name={model.name}
                            size="md"
                        />
                        <div className="flex min-w-0 flex-col">
                            <span className="truncate font-semibold">{model.name}</span>
                            <span className="truncate text-sm text-muted-foreground">
                                on {model.base}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function HeaderMock({ style, model }: { style: AvatarStyle; model: SampleModel }) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">Page header</span>
            <div className="flex min-w-0 items-center gap-4 rounded-lg border bg-background p-4">
                <AvatarTile choice={choiceFor(style.id, model.name)} name={model.name} size="lg" />
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-3xl font-normal">{model.name}</span>
                        <Badge variant="outline">Custom</Badge>
                    </div>
                    <span className="truncate text-base text-muted-foreground">
                        v{model.version} on {model.base}
                    </span>
                </div>
            </div>
        </div>
    );
}

function LogoLabel({ logo, name }: { logo: ReactNode; name: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            {logo}
            <span className="truncate">{name}</span>
        </span>
    );
}

function MixedRow({ style }: { style: AvatarStyle }) {
    const [first, second, third] = [MODELS[0], MODELS[2], MODELS[4]];
    const tile = (model: SampleModel, size: Exclude<AvatarSize, "xl">) => (
        <AvatarTile choice={choiceFor(style.id, model.name)} name={model.name} size={size} />
    );
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">
                Beside publisher logos (Qwen, Meta) at 48, 32 and 20 px
            </span>
            <div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
                {SIZES.map((size) => (
                    <div key={size} className="flex items-center gap-2">
                        <PublisherLogo publisher="Qwen" name="Qwen3 0.6B" size={size} />
                        {tile(first, size)}
                        <PublisherLogo publisher="Meta" name="Llama 3.2 1B" size={size} />
                        {tile(second, size)}
                        {tile(third, size)}
                    </div>
                ))}
                <div className="flex flex-col gap-2 border-t pt-3">
                    <LogoLabel
                        logo={<PublisherLogo publisher="Qwen" name="Qwen3 0.6B" size="sm" />}
                        name="Qwen3 0.6B"
                    />
                    <LogoLabel logo={tile(first, "sm")} name={first.name} />
                    <LogoLabel
                        logo={<PublisherLogo publisher="Meta" name="Llama 3.2 1B" size="sm" />}
                        name="Llama 3.2 1B"
                    />
                    <LogoLabel logo={tile(second, "sm")} name={second.name} />
                </div>
            </div>
        </div>
    );
}

type Measured = { label: string; floor: number; lowest: Record<ThemeMode, number> };

function useLowestContrast(style: AvatarStyle): Measured[] {
    const live = usePalette();
    return useMemo(() => {
        const palettes = { light: modePalette("light", live), dark: modePalette("dark", live) };
        const lowestFor = (mode: ThemeMode, index: number) =>
            Math.min(
                ...TONE_KEYS.map((tone) => {
                    const palette = palettes[mode];
                    const pair = style.pairs(palette, palette.tones[tone])[index];
                    return contrast(pair.fg, pair.bg);
                }),
            );
        return style.pairs(palettes.light, palettes.light.tones.csv).map((pair, index) => ({
            label: pair.label,
            floor: pair.floor,
            lowest: { light: lowestFor("light", index), dark: lowestFor("dark", index) },
        }));
    }, [style, live]);
}

function Ratio({ value, floor }: { value: number; floor: number }) {
    return (
        <span className={cn("tabular-nums", value < floor && "text-destructive")}>
            {value.toFixed(2)}:1
        </span>
    );
}

function Facts({ style }: { style: AvatarStyle }) {
    const measured = useLowestContrast(style);
    return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="neutral">{style.licence}</Badge>
            <span>
                Lowest of ten tones:{" "}
                {measured.map((item, index) => (
                    <span key={item.label}>
                        {index > 0 && "; "}
                        {item.label} <Ratio value={item.lowest.light} floor={item.floor} /> light,{" "}
                        <Ratio value={item.lowest.dark} floor={item.floor} /> dark (floor{" "}
                        {item.floor}:1)
                    </span>
                ))}
            </span>
        </span>
    );
}

function StyleSection({ style }: { style: AvatarStyle }) {
    return (
        <Section title={style.name} caption={<Facts style={style} />}>
            <div className="flex flex-col gap-4">
                <Strip style={style} />
                <div className="grid gap-3 lg:grid-cols-2">
                    <Shuffles style={style} />
                    <MixedRow style={style} />
                    <ListMock style={style} />
                    <HeaderMock style={style} model={MODELS[4]} />
                </div>
            </div>
        </Section>
    );
}

function StyleOption({
    style,
    name,
    seed,
    tone,
    checked,
    onSelect,
}: {
    style: AvatarStyle;
    name: string;
    seed: string;
    tone: ToneName;
    checked: boolean;
    onSelect: () => void;
}) {
    return (
        <label
            className={cn(
                "flex cursor-pointer flex-col items-center gap-2 rounded-md border p-2 hover:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                checked && "border-primary bg-accent text-accent-foreground hover:bg-accent",
            )}
        >
            <input
                type="radio"
                name="avatar-style"
                value={style.id}
                checked={checked}
                onChange={onSelect}
                className="sr-only"
            />
            <AvatarTile choice={{ style: style.id, seed, tone }} name={name} size="lg" />
            <span className="truncate text-sm">{style.name}</span>
        </label>
    );
}

function ToneSwatches({ tone, onPick }: { tone: ToneName; onPick: (tone: ToneName) => void }) {
    return (
        <fieldset className="flex flex-col gap-label">
            <legend className="mb-2 text-base font-medium">Colour</legend>
            <div className="flex flex-wrap gap-2">
                {TONE_KEYS.map((key) => (
                    <label
                        key={key}
                        className={cn(
                            "flex size-8 cursor-pointer items-center justify-center rounded-md border has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                            key === tone && "border-foreground",
                        )}
                    >
                        <input
                            type="radio"
                            name="avatar-tone"
                            value={key}
                            checked={key === tone}
                            onChange={() => onPick(key)}
                            aria-label={TONE_LABELS[key]}
                            className="sr-only"
                        />
                        <span
                            aria-hidden="true"
                            className="size-5 rounded-sm"
                            style={{ backgroundColor: `var(${toneToken(key)})` }}
                        />
                    </label>
                ))}
            </div>
        </fieldset>
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
    const [draft, setDraft] = useState(value);
    const displayName = name.trim() || "Untitled model";
    const shuffle = () => {
        const seed = randomSeed(displayName);
        setDraft((previous) => ({ ...previous, seed, tone: seedTone(displayName, seed) }));
    };
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (next) {
                    setDraft(value);
                }
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Avatar</DialogTitle>
                    <DialogDescription>
                        Pick a style and a colour, then shuffle until one fits {displayName}.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-6 sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <div className="flex flex-col items-center gap-3">
                        <AvatarTile choice={draft} name={displayName} size="xl" />
                        <span className="max-w-full truncate font-semibold">{displayName}</span>
                        <span className="text-sm text-muted-foreground">
                            {styleById(draft.style).name}
                        </span>
                        <Button type="button" variant="outline" onClick={shuffle}>
                            Shuffle
                        </Button>
                    </div>
                    <div className="flex min-w-0 flex-col gap-field">
                        <fieldset className="flex flex-col">
                            <legend className="mb-2 text-base font-medium">Style</legend>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {AVATAR_STYLES.map((style) => (
                                    <StyleOption
                                        key={style.id}
                                        style={style}
                                        name={displayName}
                                        seed={draft.seed}
                                        tone={draft.tone}
                                        checked={draft.style === style.id}
                                        onSelect={() =>
                                            setDraft((previous) => ({
                                                ...previous,
                                                style: style.id,
                                            }))
                                        }
                                    />
                                ))}
                            </div>
                        </fieldset>
                        <ToneSwatches
                            tone={draft.tone}
                            onPick={(tone) => setDraft((previous) => ({ ...previous, tone }))}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <DialogClose render={<Button variant="outline">Cancel</Button>} />
                    <Button
                        type="button"
                        onClick={() => {
                            onUse(draft);
                            onOpenChange(false);
                        }}
                    >
                        Use this avatar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AvatarPickerMock() {
    const [name, setName] = useState("Support triage");
    const [choice, setChoice] = useState(() => choiceFor("initials", "Support triage"));
    const [open, setOpen] = useState(false);
    const displayName = name.trim() || "Untitled model";
    return (
        <Section
            title="Avatar picker"
            caption="A working mock of Add model's name row. Select the avatar to change its style, seed and colour; nothing is saved."
        >
            <div className="flex max-w-xl flex-col gap-label">
                <Label htmlFor="avatar-mock-name">Name</Label>
                <div className="flex items-center gap-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                aria-label="Change avatar"
                                aria-haspopup="dialog"
                                onClick={() => setOpen(true)}
                                className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            >
                                <AvatarTile choice={choice} name={displayName} size="md" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Change avatar</TooltipContent>
                    </Tooltip>
                    <Input
                        id="avatar-mock-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
                <span className="text-sm text-muted-foreground">
                    Stored:{" "}
                    <code className="font-mono">
                        {`{ style: "${choice.style}", seed: "${choice.seed}", tone: "${choice.tone}" }`}
                    </code>
                    . The tone is a name, resolved to the theme's colour at render time.
                </span>
            </div>
            <PickerDialog
                open={open}
                onOpenChange={setOpen}
                name={name}
                value={choice}
                onUse={setChoice}
            />
        </Section>
    );
}

export function AvatarStyles() {
    return (
        <>
            <AvatarPickerMock />
            {AVATAR_STYLES.map((style) => (
                <div key={style.id} id={`avatar-${style.id}`} className="scroll-mt-4">
                    <StyleSection style={style} />
                </div>
            ))}
        </>
    );
}
