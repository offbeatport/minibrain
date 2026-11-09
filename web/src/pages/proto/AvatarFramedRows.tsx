import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "obp-ui";
import { Fragment, useMemo } from "react";
import { PublisherLogo } from "~/components/PublisherLogo";
import {
    type AvatarSize,
    type AvatarStyle,
    AvatarTile,
    type FramedVariant,
    type Palette,
    TONE_LABELS,
    type ThemeMode,
    choiceFor,
    contrast,
    modePalette,
    usePalette,
} from "./avatarDicebear";
import { MODELS, TONE_KEYS, type ToneName, toneToken } from "./modelIcons";

const MODES: ThemeMode[] = ["light", "dark"];
const MODE_LABEL: Record<ThemeMode, string> = { light: "Light", dark: "Dark" };
const MIXED_SIZES: Exclude<AvatarSize, "xl">[] = ["lg", "md", "sm"];

function usePalettesByMode(): Record<ThemeMode, Palette> {
    const live = usePalette();
    return useMemo(
        () => ({ light: modePalette("light", live), dark: modePalette("dark", live) }),
        [live],
    );
}

function CustomLabel({
    style,
    name,
    framed,
}: {
    style: AvatarStyle;
    name: string;
    framed: FramedVariant;
}) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <AvatarTile choice={choiceFor(style.id, name)} name={name} size="sm" framed={framed} />
            <span className="truncate">{name}</span>
        </span>
    );
}

function BaseLabel({ publisher, name }: { publisher: string; name: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <PublisherLogo publisher={publisher} name={name} size="sm" />
            <span className="truncate">{name}</span>
        </span>
    );
}

export function MixedRow({ style, framed }: { style: AvatarStyle; framed: FramedVariant }) {
    const [first, second, third] = [MODELS[0], MODELS[2], MODELS[4]];
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">
                Beside publisher logos (Qwen, Meta) at 48, 32 and 20 px
            </span>
            <div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
                {MIXED_SIZES.map((size) => (
                    <div key={size} className="flex items-center gap-2">
                        <PublisherLogo publisher="Qwen" name="Qwen3 0.6B" size={size} />
                        <AvatarTile
                            choice={choiceFor(style.id, first.name)}
                            name={first.name}
                            size={size}
                            framed={framed}
                        />
                        <PublisherLogo publisher="Meta" name="Llama 3.2 1B" size={size} />
                        <AvatarTile
                            choice={choiceFor(style.id, second.name)}
                            name={second.name}
                            size={size}
                            framed={framed}
                        />
                        <AvatarTile
                            choice={choiceFor(style.id, third.name)}
                            name={third.name}
                            size={size}
                            framed={framed}
                        />
                    </div>
                ))}
                <div className="flex flex-col gap-2 border-t pt-3">
                    <BaseLabel publisher="Qwen" name="Qwen3 0.6B" />
                    <CustomLabel style={style} name={first.name} framed={framed} />
                    <BaseLabel publisher="Meta" name="Llama 3.2 1B" />
                    <CustomLabel style={style} name={second.name} framed={framed} />
                </div>
            </div>
        </div>
    );
}

function Ratio({ value, floor }: { value: number; floor: number }) {
    return (
        <span className={cn("tabular-nums", value < floor && "text-destructive")}>
            {value.toFixed(2)}
        </span>
    );
}

type Row = { tone: ToneName; values: number[] };

export function ContrastTable({ framed }: { framed: FramedVariant }) {
    const palettes = usePalettesByMode();
    const { sample, rows } = useMemo(() => {
        const pairs = framed.pairs(palettes.light, palettes.light.tones.csv);
        const measured: Row[] = TONE_KEYS.map((tone) => ({
            tone,
            values: pairs.flatMap((_, index) =>
                MODES.map((mode) => {
                    const palette = palettes[mode];
                    const pair = framed.pairs(palette, palette.tones[tone])[index];
                    return contrast(pair.fg, pair.bg);
                }),
            ),
        }));
        return { sample: pairs, rows: measured };
    }, [framed, palettes]);
    if (sample.length === 0) {
        return null;
    }
    const lowest = rows[0].values.map((_, column) =>
        Math.min(...rows.map((row) => row.values[column])),
    );
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">
                Contrast in both themes, computed from the Cobalt preset and the kit's file tones.
                Red is below the floor: 4.5:1 for letters, 3:1 for shapes.
            </span>
            <div className="overflow-x-auto rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead rowSpan={2}>Tone</TableHead>
                            {sample.map((pair) => (
                                <TableHead key={pair.label} colSpan={2}>
                                    {pair.label} ({pair.floor}:1)
                                </TableHead>
                            ))}
                        </TableRow>
                        <TableRow>
                            {sample.map((pair) => (
                                <Fragment key={pair.label}>
                                    {MODES.map((mode) => (
                                        <TableHead key={mode}>{MODE_LABEL[mode]}</TableHead>
                                    ))}
                                </Fragment>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.tone}>
                                <TableCell>
                                    <span className="flex items-center gap-2">
                                        <span
                                            aria-hidden="true"
                                            className="size-3 rounded-sm"
                                            style={{
                                                backgroundColor: `var(${toneToken(row.tone)})`,
                                            }}
                                        />
                                        {TONE_LABELS[row.tone]}
                                        <span className="font-mono text-sm text-muted-foreground">
                                            {row.tone}
                                        </span>
                                    </span>
                                </TableCell>
                                {row.values.map((value, column) => (
                                    <TableCell
                                        key={`${row.tone}-${sample[Math.floor(column / 2)].label}-${MODES[column % 2]}`}
                                    >
                                        <Ratio
                                            value={value}
                                            floor={sample[Math.floor(column / 2)].floor}
                                        />
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                        <TableRow>
                            <TableCell className="font-semibold">Lowest</TableCell>
                            {lowest.map((value, column) => (
                                <TableCell
                                    key={`lowest-${sample[Math.floor(column / 2)].label}-${MODES[column % 2]}`}
                                    className="font-semibold"
                                >
                                    <Ratio
                                        value={value}
                                        floor={sample[Math.floor(column / 2)].floor}
                                    />
                                </TableCell>
                            ))}
                        </TableRow>
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
