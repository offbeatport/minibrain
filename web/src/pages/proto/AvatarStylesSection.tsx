import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "obp-ui";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Section } from "~/components/Section";
import { type AvatarSize, AvatarTile } from "~/components/avatar/AvatarTile";
import { type Identity, NameAvatarField, newIdentity } from "~/components/avatar/NameAvatarField";
import {
    AVATAR_STYLES,
    type AvatarStyle,
    type Palette,
    contrast,
} from "~/components/avatar/avatarStyles";
import { choiceFor } from "~/components/avatar/avatarSvg";
import { type ThemeMode, modePalette, usePalette } from "~/components/avatar/palette";
import { TONE_KEYS, TONE_LABELS } from "~/components/avatar/tones";
import { type Lowest, RENDER_SIZES, type RenderedRow, measureRendered } from "./avatarContrast";
import { MODELS, type SampleModel } from "./modelIcons";

const SIZES: Exclude<AvatarSize, "field" | "xl" | "hero" | "fill">[] = ["lg", "md", "sm"];

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
    const tile = (
        model: SampleModel,
        size: Exclude<AvatarSize, "field" | "xl" | "hero" | "fill">,
    ) => <AvatarTile choice={choiceFor(style.id, model.name)} name={model.name} size={size} />;
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

type Measured = { label: string; floor: number; lowest: Record<ThemeMode, Lowest> };

type Rendered = Record<ThemeMode, RenderedRow[]>;

function useModePalettes(): Record<ThemeMode, Palette> {
    const live = usePalette();
    return useMemo(
        () => ({ light: modePalette("light", live), dark: modePalette("dark", live) }),
        [live],
    );
}

function useLowestContrast(style: AvatarStyle): Measured[] {
    const palettes = useModePalettes();
    return useMemo(() => {
        const lowestFor = (mode: ThemeMode, index: number): Lowest => {
            const palette = palettes[mode];
            return TONE_KEYS.map((tone) => {
                const pair = style.pairs(palette, palette.tones[tone])[index];
                return { value: contrast(pair.fg, pair.bg), tone };
            }).reduce((low, item) => (item.value < low.value ? item : low));
        };
        return style.pairs(palettes.light, palettes.light.tones.csv).map((pair, index) => ({
            label: pair.label,
            floor: pair.floor,
            lowest: { light: lowestFor("light", index), dark: lowestFor("dark", index) },
        }));
    }, [style, palettes]);
}

function useRendered(style: AvatarStyle): Rendered | null {
    const palettes = useModePalettes();
    const [rendered, setRendered] = useState<Rendered | null>(null);
    useEffect(() => {
        let live = true;
        setRendered(null);
        Promise.all([
            measureRendered(style, palettes.light),
            measureRendered(style, palettes.dark),
        ]).then(([light, dark]) => {
            if (live) {
                setRendered({ light, dark });
            }
        });
        return () => {
            live = false;
        };
    }, [style, palettes]);
    return rendered;
}

function Ratio({ lowest, floor }: { lowest: Lowest | undefined; floor: number }) {
    if (!lowest || !Number.isFinite(lowest.value)) {
        return <span className="text-muted-foreground">Measuring</span>;
    }
    const fails = lowest.value < floor;
    return (
        <span className="flex flex-col">
            <span className={cn("tabular-nums", fails && "text-destructive")}>
                {lowest.value.toFixed(2)}:1{fails ? ", below floor" : ""}
            </span>
            <span className="text-sm text-muted-foreground">{TONE_LABELS[lowest.tone]}</span>
        </span>
    );
}

function StyleRows({ style }: { style: AvatarStyle }) {
    const measured = useLowestContrast(style);
    const rendered = useRendered(style);
    return measured.map((item, index) => (
        <TableRow key={item.label} data-style={style.id}>
            <TableCell className="font-medium">{index === 0 ? style.name : ""}</TableCell>
            <TableCell>{item.label}</TableCell>
            <TableCell className="tabular-nums">{item.floor}:1</TableCell>
            {(["light", "dark"] as const).map((mode) => (
                <Fragment key={mode}>
                    <TableCell>
                        <Ratio lowest={item.lowest[mode]} floor={item.floor} />
                    </TableCell>
                    {RENDER_SIZES.map((size) => (
                        <TableCell key={size}>
                            <Ratio
                                lowest={rendered?.[mode][index]?.lowest[size]}
                                floor={item.floor}
                            />
                        </TableCell>
                    ))}
                </Fragment>
            ))}
        </TableRow>
    ));
}

function ContrastTable() {
    return (
        <Section
            title="Contrast"
            caption="The lowest ratio across the ten tones against Cobalt's light and dark tokens: the token pair, then the strongest rendered pixel of that feature with the tile drawn at 176 and 20 px at 1x, over six seeds. Letters need 4.5:1, shapes 3:1."
        >
            <div className="overflow-x-auto rounded-lg border">
                <Table data-testid="contrast-table">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Style</TableHead>
                            <TableHead>Pair</TableHead>
                            <TableHead>Floor</TableHead>
                            <TableHead>Light, tokens</TableHead>
                            <TableHead>Light, 176 px</TableHead>
                            <TableHead>Light, 20 px</TableHead>
                            <TableHead>Dark, tokens</TableHead>
                            <TableHead>Dark, 176 px</TableHead>
                            <TableHead>Dark, 20 px</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {AVATAR_STYLES.map((style) => (
                            <StyleRows key={style.id} style={style} />
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Section>
    );
}

function StyleSection({ style }: { style: AvatarStyle }) {
    return (
        <Section title={style.name} caption={<Badge variant="neutral">{style.licence}</Badge>}>
            <div className="flex flex-col gap-4">
                <Strip style={style} />
                <div className="grid gap-3 lg:grid-cols-2">
                    <MixedRow style={style} />
                    <ListMock style={style} />
                    <HeaderMock style={style} model={MODELS[4]} />
                </div>
            </div>
        </Section>
    );
}

function AvatarPickerMock() {
    const names = new Set(MODELS.map((model) => model.name.toLowerCase()));
    const taken = (name: string) => names.has(name.toLowerCase());
    const [identity, setIdentity] = useState<Identity>(() => newIdentity(taken));
    const { style, seed, tone, letters } = identity.avatar;
    const stored = JSON.stringify(letters ? { style, seed, tone, letters } : { style, seed, tone });
    return (
        <Section
            title="Name and avatar"
            caption="The Add model name row. Shuffle rerolls what you have not chosen; select the avatar to open the picker. Nothing is saved."
        >
            <div className="flex max-w-xl flex-col">
                <NameAvatarField
                    id="avatar-mock-name"
                    value={identity}
                    onChange={setIdentity}
                    taken={taken}
                >
                    <span className="text-sm text-muted-foreground">
                        Stored <code className="font-mono break-all">{stored}</code>
                    </span>
                </NameAvatarField>
            </div>
        </Section>
    );
}

export function AvatarStyles() {
    return (
        <>
            <AvatarPickerMock />
            <ContrastTable />
            {AVATAR_STYLES.map((style) => (
                <div key={style.id} id={`avatar-${style.id}`} className="scroll-mt-4">
                    <StyleSection style={style} />
                </div>
            ))}
        </>
    );
}
