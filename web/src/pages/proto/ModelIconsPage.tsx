import {
    Badge,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    ThemeToggle,
    cn,
} from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";
import {
    CurrentLogo,
    MODELS,
    type SampleModel,
    TONE_TOKENS,
    VARIANTS,
    type Variant,
} from "./modelIcons";

type Library = {
    name: string;
    version: string;
    licence: string;
    size: string;
    released: string;
    offline: string;
    theme: string;
    verdict: string;
};

const LIBRARIES: Library[] = [
    {
        name: "boring-avatars",
        version: "2.0.4",
        licence: "MIT",
        size: "2.8 KB",
        released: "2025-09-28",
        offline: "Yes: a React component that renders inline SVG",
        theme: "Takes any CSS colour, so kit tokens pass straight in. Marble blurs and sunset is a gradient; beam is a face and reads hex for its contrast",
        verdict: "Usable: bauhaus and pixel only (15, 16)",
    },
    {
        name: "DiceBear",
        version: "@dicebear/core 9.4.3 (v9 LTS)",
        licence:
            "MIT code; identicon and shapes designs CC0 1.0. Other styles vary and several are CC BY 4.0, which needs attribution",
        size: "2.9 KB core; 4.2 KB with identicon; 4.6 KB with shapes",
        released: "9.4.3 on 2026-07-05; 10.7.0 on 2026-08-26 moves styles to JSON definitions",
        offline: "Yes: createAvatar().toString() returns an SVG string",
        theme: "Emits hex, so placeholder hexes are swapped for tokens. Strip its metadata and fixed viewboxMask id, which collides between inline SVGs",
        verdict: "Usable: shapes and identicon (17, 18); identicon is easy to write in-house",
    },
    {
        name: "jdenticon",
        version: "3.3.0",
        licence: "MIT",
        size: "2.8 KB",
        released: "2024-05-10",
        offline: "Yes: toSvg() returns an SVG string",
        theme: "Its own HSL hex colours only, tuned here for mid lightness so they read on both themes",
        verdict:
            "Avoid: off-palette, and its built-in hash is SHA-1, which the repo's FIPS rule forbids",
    },
    {
        name: "minidenticons",
        version: "4.2.1",
        licence: "MIT",
        size: "0.5 KB",
        released: "2024-03-01",
        offline: "Yes: minidenticon() returns an SVG string; the hash is pluggable",
        theme: "One fill, swapped for currentColor, so any token works",
        verdict: "Usable (20), but small enough to write in-house",
    },
    {
        name: "avvvatars-react",
        version: "0.4.2",
        licence: "MIT",
        size: "Not installed",
        released: "2022-04-11",
        offline: "Yes, but styles through goober CSS-in-JS at runtime",
        theme: "Its own palette",
        verdict: "Skip: unmaintained; letters and shapes repeat 1 to 3 and 12",
    },
    {
        name: "identicon.js",
        version: "2.3.3",
        licence: "BSD",
        size: "Not installed",
        released: "2022-06-19",
        offline: "Yes: PNG or SVG as a base64 string",
        theme: "Literal colours inside an image, no tokens",
        verdict: "Skip",
    },
];

function Strip({ variant }: { variant: Variant }) {
    const { Icon } = variant;
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {MODELS.map((model) => (
                <div
                    key={model.name}
                    className="flex min-w-0 flex-col gap-2 rounded-md border bg-background p-3"
                >
                    <div className="flex items-end gap-3">
                        <Icon model={model} size="lg" />
                        <Icon model={model} size="md" />
                        <Icon model={model} size="sm" />
                    </div>
                    <span className="truncate text-sm text-muted-foreground">{model.name}</span>
                </div>
            ))}
        </div>
    );
}

function ListMock({ variant }: { variant: Variant }) {
    const { Icon } = variant;
    return (
        <div className="flex flex-col gap-2">
            <span className="text-sm text-muted-foreground">Models list</span>
            <div className="divide-y rounded-lg border bg-card">
                {MODELS.slice(0, 3).map((model) => (
                    <div key={model.name} className="flex items-center gap-3 px-4 py-3">
                        <Icon model={model} size="md" />
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

function PickerMock({ variant }: { variant: Variant }) {
    const { Icon } = variant;
    return (
        <div className="flex flex-col gap-2">
            <span className="text-sm text-muted-foreground">Picker</span>
            <div className="flex flex-col rounded-lg border bg-popover p-1">
                {MODELS.map((model, index) => (
                    <div
                        key={model.name}
                        className={cn(
                            "flex h-8 items-center gap-2 rounded-md px-2",
                            index === 1 && "bg-accent text-accent-foreground",
                        )}
                    >
                        <Icon model={model} size="sm" />
                        <span className="truncate">{model.name}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function HeaderMock({ variant, model }: { variant: Variant; model: SampleModel }) {
    const { Icon } = variant;
    return (
        <div className="flex min-w-0 items-center gap-4 rounded-lg border bg-background p-4">
            <Icon model={model} size="lg" />
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
    );
}

function Context({ variant }: { variant: Variant }) {
    return (
        <div className="grid gap-3 lg:grid-cols-3">
            <ListMock variant={variant} />
            <PickerMock variant={variant} />
            <div className="flex min-w-0 flex-col gap-2">
                <span className="text-sm text-muted-foreground">Page header</span>
                <HeaderMock variant={variant} model={MODELS[0]} />
                <HeaderMock variant={variant} model={MODELS[4]} />
            </div>
        </div>
    );
}

function VariantSection({ number, variant }: { number: number; variant: Variant }) {
    return (
        <Section
            title={`${number}. ${variant.name}`}
            caption={
                <div className="flex flex-col gap-2">
                    <span className="text-base text-foreground">{variant.idea}</span>
                    <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{variant.source}</Badge>
                        <Badge variant="neutral">{variant.licence}</Badge>
                        {variant.bends && <span>Bends: {variant.bends}</span>}
                    </span>
                </div>
            }
        >
            <div className="flex flex-col gap-4">
                <Strip variant={variant} />
                <Context variant={variant} />
            </div>
        </Section>
    );
}

function Overview() {
    return (
        <Section
            title="All twenty"
            caption="The six names at 32 px and, below, at 20 px. Select one to jump to it."
        >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {VARIANTS.map((variant, index) => {
                    const { Icon } = variant;
                    return (
                        <a
                            key={variant.name}
                            href={`#variant-${index + 1}`}
                            className="flex min-w-0 flex-col gap-2 rounded-md border bg-background p-3 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <span className="truncate">
                                {index + 1}. {variant.name}
                            </span>
                            <span className="flex items-center gap-2">
                                {MODELS.map((model) => (
                                    <Icon key={model.name} model={model} size="md" />
                                ))}
                            </span>
                            <span className="flex items-center gap-2">
                                {MODELS.map((model) => (
                                    <span key={model.name} className="flex w-8 justify-center">
                                        <Icon model={model} size="sm" />
                                    </span>
                                ))}
                            </span>
                        </a>
                    );
                })}
            </div>
        </Section>
    );
}

function Notes() {
    return (
        <Section
            title="How to read this page"
            caption="The page follows the app theme. Check every design in both."
            actions={<ThemeToggle />}
        >
            <div className="flex flex-col gap-3 text-base">
                <div className="flex flex-wrap items-center gap-3">
                    <span>Today a custom model shows its first letter:</span>
                    <CurrentLogo model={MODELS[0]} size="sm" />
                    <CurrentLogo model={MODELS[0]} size="md" />
                    <CurrentLogo model={MODELS[0]} size="lg" />
                </div>
                <p>
                    Every design is deterministic: the slug of the name goes through cyrb53, a
                    non-cryptographic 53-bit hash, which picks the tone and seeds the shapes.
                    Nothing loads from a network; all of it is inline SVG or DOM.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <span>
                        Tones are the kit's ten file-type tokens, set for both themes. Card ink on a
                        solid tone measures at least 4.98:1 light and 6.79:1 dark; ink on a tint
                        (the tone mixed 75% with the foreground) at least 5.65:1 and 7.39:1:
                    </span>
                    {TONE_TOKENS.map((token) => (
                        <span key={token} className="flex items-center gap-1.5">
                            <span
                                className="size-3 rounded-sm"
                                style={{ backgroundColor: `var(${token})` }}
                            />
                            <span className="font-mono text-sm text-muted-foreground">{token}</span>
                        </span>
                    ))}
                </div>
            </div>
        </Section>
    );
}

function Libraries() {
    return (
        <Section
            title="Libraries"
            caption="Gzipped size is the minified import used here, measured with esbuild. All render synchronously with no network."
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Library</TableHead>
                        <TableHead>Licence</TableHead>
                        <TableHead>Gzipped</TableHead>
                        <TableHead>Last release</TableHead>
                        <TableHead>Offline SVG</TableHead>
                        <TableHead>Theme fit</TableHead>
                        <TableHead>Verdict</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {LIBRARIES.map((library) => (
                        <TableRow key={library.name}>
                            <TableCell className="align-top whitespace-normal">
                                <span className="flex flex-col">
                                    <span className="font-semibold">{library.name}</span>
                                    <span className="text-sm text-muted-foreground">
                                        {library.version}
                                    </span>
                                </span>
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                                {library.licence}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                                {library.size}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                                {library.released}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                                {library.offline}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                                {library.theme}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                                {library.verdict}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </Section>
    );
}

export function ModelIconsPage() {
    return (
        <Page wide>
            <PageHeader
                title="Model icons"
                caption="Twenty designs for a custom model's logo, each for six names at 20, 32 and 48 px and in the list, picker and page header. Prototype; not in the sidebar."
            />
            <Notes />
            <Overview />
            {VARIANTS.map((variant, index) => (
                <div key={variant.name} id={`variant-${index + 1}`} className="scroll-mt-4">
                    <VariantSection number={index + 1} variant={variant} />
                </div>
            ))}
            <Libraries />
        </Page>
    );
}
