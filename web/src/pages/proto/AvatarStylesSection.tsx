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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { useMemo, useState } from "react";
import { Section } from "~/components/Section";
import {
    AVATAR_STYLES,
    type AvatarChoice,
    type AvatarStyle,
    type AvatarStyleId,
    AvatarTile,
    TONE_NAMES,
    avatarSvg,
    baseSeed,
    featuresOf,
    randomSeed,
    seedTone,
    usePalette,
} from "./avatarDicebear";
import { MODELS, type SampleModel, TONE_TOKENS } from "./modelIcons";

const GZIPPED: Record<AvatarStyleId, string> = {
    initials: "0.7 KB",
    waves: "1.6 KB",
    planets: "3.5 KB",
    "voxel-art": "8.5 KB",
    "voxel-bot": "3.1 KB",
    pixelbot: "1.8 KB",
    bottts: "25.8 KB",
    "bottts-neutral": "22.9 KB",
};

function choiceFor(style: AvatarStyleId, name: string, seed = baseSeed(name)): AvatarChoice {
    return { style, seed, tone: seedTone(name, seed) };
}

function shuffleSeeds(name: string): string[] {
    const base = baseSeed(name);
    return [base, `${base}-1`, `${base}-2`];
}

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
                            <AvatarTile choice={choice} name={model.name} size="lg" />
                            <AvatarTile choice={choice} name={model.name} size="md" />
                            <AvatarTile choice={choice} name={model.name} size="sm" />
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
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">
                {style.id === "initials"
                    ? `Shuffle: three seeds of ${model.name}; the letters stay, the colour moves`
                    : `Shuffle: three seeds of ${model.name}`}
            </span>
            <div className="flex items-end gap-3 rounded-lg border bg-background p-4">
                {shuffleSeeds(model.name).map((seed) => (
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

function useFeatures(style: AvatarStyle): string {
    const palette = usePalette();
    return useMemo(() => {
        const markups = MODELS.map((model) =>
            avatarSvg(choiceFor(style.id, model.name), model.name, palette),
        );
        const found = featuresOf(markups).filter((feature) => feature.count > 0);
        if (found.length === 0) {
            return "None: flat fills only";
        }
        return found
            .map((feature) => `${feature.label} (${feature.count} in six avatars)`)
            .join(", ");
    }, [style.id, palette]);
}

function Facts({ style }: { style: AvatarStyle }) {
    const features = useFeatures(style);
    const rows: [string, string][] = [
        ["Licence", `${style.licence}, by ${style.artist}`],
        ["Effects in the SVG", features],
        ["Recolour", style.recolour],
        ["At 20 px", style.at20],
        ["Gzipped definition", GZIPPED[style.id]],
    ];
    return (
        <dl className="grid gap-x-6 gap-y-1 md:grid-cols-[10rem_minmax(0,1fr)]">
            {rows.map(([term, value]) => (
                <div key={term} className="contents">
                    <dt className="text-muted-foreground">{term}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

function StyleSection({ style }: { style: AvatarStyle }) {
    return (
        <Section
            title={style.name}
            caption={
                <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={style.recommended ? "success" : "warning"}>
                        {style.recommended ? "Recommended" : "For comparison"}
                    </Badge>
                    <Badge variant="neutral">{style.licenceBadge}</Badge>
                    <span>{style.verdict}</span>
                </span>
            }
        >
            <div className="flex flex-col gap-4">
                <Facts style={style} />
                <Strip style={style} />
                <div className="grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
                    <Shuffles style={style} />
                    <ListMock style={style} />
                    <HeaderMock style={style} model={MODELS[4]} />
                </div>
            </div>
        </Section>
    );
}

function SummaryRow({ style }: { style: AvatarStyle }) {
    const features = useFeatures(style);
    return (
        <TableRow>
            <TableCell className="align-top whitespace-normal">
                <a href={`#avatar-${style.id}`} className="flex items-center gap-3 hover:underline">
                    <AvatarTile
                        choice={choiceFor(style.id, MODELS[0].name)}
                        name={MODELS[0].name}
                        size="md"
                    />
                    <span className="font-semibold">{style.name}</span>
                </a>
            </TableCell>
            <TableCell className="align-top whitespace-normal">{style.licence}</TableCell>
            <TableCell className="align-top whitespace-normal">{features}</TableCell>
            <TableCell className="align-top whitespace-normal">{style.recolour}</TableCell>
            <TableCell className="align-top whitespace-normal">{style.at20}</TableCell>
            <TableCell className="align-top whitespace-normal tabular-nums">
                {GZIPPED[style.id]}
            </TableCell>
            <TableCell className="align-top whitespace-normal">{style.verdict}</TableCell>
        </TableRow>
    );
}

function Summary() {
    return (
        <Section
            title="Avatar styles"
            caption="DiceBear 10 styles rendered live from @dicebear/styles 10.6.0 with @dicebear/core 10.7.0, recoloured from the kit's file tones for the current theme. Effects are counted in the generated markup."
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Style</TableHead>
                        <TableHead>Licence</TableHead>
                        <TableHead>Gradients, filters, blur, opacity</TableHead>
                        <TableHead>Recolourable</TableHead>
                        <TableHead>At 20 px</TableHead>
                        <TableHead>Gzipped</TableHead>
                        <TableHead>Verdict</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {AVATAR_STYLES.map((style) => (
                        <SummaryRow key={style.id} style={style} />
                    ))}
                    <TableRow>
                        <TableCell className="align-top whitespace-normal font-semibold">
                            Voxel Box
                        </TableCell>
                        <TableCell className="align-top whitespace-normal" colSpan={6}>
                            No such style: neither @dicebear/styles 10.6.0 nor 11.0.0-rc.3 ships
                            one. The voxel styles are Voxel Art and Voxel Bot.
                        </TableCell>
                    </TableRow>
                </TableBody>
            </Table>
        </Section>
    );
}

function DicebearNotes() {
    return (
        <Section title="DiceBear 10: what shipping it means">
            <ul className="flex list-disc flex-col gap-2 pl-5">
                <li>
                    Core 10.7.0 is MIT and 24.9 KB gzipped on its own (9.4.3 was 2.9 KB): it
                    validates every style and option against a compiled JSON schema. With the six
                    recommended styles it is 41.9 KB gzipped.
                </li>
                <li>
                    @dicebear/styles exports one JSON file per style and is side-effect free, so a
                    bundle holds only the styles it imports. Importing one style does not pull in
                    the other 60.
                </li>
                <li>
                    The package itself holds all 61 styles (2.9 MB minified, 4.6 MB source). 42 are
                    CC0, but 14 are CC BY 4.0 (Adventurer, Big Ears, Croodles, Micah, Personas and
                    others: attribution required), 4 use Pablo Stanley's own terms (Avataaars,
                    Bottts and their Neutral twins), and Icons is MIT. Using the package as a
                    build-time dependency is fine; vendoring or mirroring it redistributes that
                    artwork, so its LICENSE.md must travel with it.
                </li>
                <li>
                    Every style shown here as recommended is CC0 by DiceBear: no attribution, no
                    notice. The generated SVG embeds a licence block in its metadata, which this
                    page strips.
                </li>
                <li>
                    Presets are not part of either npm package, in 10.x or 11.0.0-rc. They exist
                    only on dicebear.com as named sets of ordinary options (for example Voxel Bot
                    "Bare" is topProbability 0 and chestProbability 0), so they work with 10.x by
                    passing the options. There is no "Default" preset: default is no options.
                </li>
            </ul>
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
    tone: number;
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

function ToneSwatches({ tone, onPick }: { tone: number; onPick: (tone: number) => void }) {
    return (
        <fieldset className="flex flex-col gap-label">
            <legend className="mb-2 text-base font-medium">Colour</legend>
            <div className="flex flex-wrap gap-2">
                {TONE_TOKENS.map((token, index) => (
                    <label
                        key={token}
                        className={cn(
                            "flex size-8 cursor-pointer items-center justify-center rounded-md border has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                            index === tone && "border-foreground",
                        )}
                    >
                        <input
                            type="radio"
                            name="avatar-tone"
                            value={index}
                            checked={index === tone}
                            onChange={() => onPick(index)}
                            aria-label={TONE_NAMES[index]}
                            className="sr-only"
                        />
                        <span
                            aria-hidden="true"
                            className="size-5 rounded-sm"
                            style={{ backgroundColor: `var(${token})` }}
                        />
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

function PickerDialog({
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
    const current = AVATAR_STYLES.find((style) => style.id === draft.style) ?? AVATAR_STYLES[0];
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
                        Pick a style, then shuffle until one fits {displayName}.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-6 sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <div className="flex flex-col items-center gap-3">
                        <AvatarTile choice={draft} name={displayName} size="xl" />
                        <span className="max-w-full truncate font-semibold">{displayName}</span>
                        <span className="text-sm text-muted-foreground">{current.name}</span>
                        <Button type="button" variant="outline" onClick={shuffle}>
                            Shuffle
                        </Button>
                    </div>
                    <div className="flex min-w-0 flex-col gap-field">
                        <fieldset className="flex flex-col">
                            <legend className="mb-2 text-base font-medium">Style</legend>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {AVATAR_STYLES.filter((style) => style.recommended).map((style) => (
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
                        {draft.style === "initials" ? (
                            <ToneSwatches
                                tone={draft.tone}
                                onPick={(tone) => setDraft((previous) => ({ ...previous, tone }))}
                            />
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                Colours follow the seed. Shuffle for another.
                            </p>
                        )}
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

export function AvatarPickerMock({ defaultOpen = false }: { defaultOpen?: boolean }) {
    const [name, setName] = useState("Support triage");
    const [choice, setChoice] = useState(() => choiceFor("initials", "Support triage"));
    const [open, setOpen] = useState(defaultOpen);
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
            <Summary />
            <DicebearNotes />
            {AVATAR_STYLES.map((style) => (
                <div key={style.id} id={`avatar-${style.id}`} className="scroll-mt-4">
                    <StyleSection style={style} />
                </div>
            ))}
        </>
    );
}
