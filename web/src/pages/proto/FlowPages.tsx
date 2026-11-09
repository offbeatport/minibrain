import { useParams, useRouter } from "@tanstack/react-router";
import { Shuffle } from "lucide-react";
import {
    Badge,
    Button,
    Input,
    Label,
    Link,
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
    useToast,
} from "obp-ui";
import { type FormEvent, useState } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Page, Section } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { useSearchParam } from "~/lib/listSearch";
import { PickerDialog } from "./AvatarStylesSection";
import { type AvatarChoice, AvatarTile, choiceFor } from "./avatarDicebear";
import {
    CATALOG,
    type CatalogEntry,
    FLOW,
    type FlowModel,
    attention,
    baseModelSlug,
    catalogEntry,
    catalogHref,
    createModel,
    liveVersion,
    modelHref,
    nextStep,
    pct,
    useFlowState,
} from "./modelsFlowData";
import { Crumbs, ModelAvatar } from "./modelsFlowParts";

const ADJECTIVES = [
    "Steady",
    "Quiet",
    "Bright",
    "Nimble",
    "Patient",
    "Lucid",
    "Brisk",
    "Gentle",
    "Keen",
    "Sturdy",
];
const NOUNS = [
    "Heron",
    "Otter",
    "Falcon",
    "Lynx",
    "Badger",
    "Wren",
    "Marten",
    "Ibex",
    "Plover",
    "Finch",
];

function randomName(): string {
    const [first, second] = crypto.getRandomValues(new Uint8Array(2));
    return `${ADJECTIVES[first % ADJECTIVES.length]} ${NOUNS[second % NOUNS.length]}`;
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function ModelLine({ model, detail, href }: { model: FlowModel; detail: string; href: string }) {
    return (
        <li>
            <Link href={href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary">
                <ModelAvatar model={model} />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">{model.name}</span>
                    <span className="truncate text-sm text-muted-foreground">{detail}</span>
                </span>
            </Link>
        </li>
    );
}

function GetStarted({ hasOwn }: { hasOwn: boolean }) {
    const steps = [
        "Pick a base in Discover",
        "Add a model on it",
        "Add data",
        "Train v1",
        "Deploy it and call its API",
    ];
    return (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-panel">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-lg font-semibold">Get started</h2>
                    <p className="text-muted-foreground">
                        {hasOwn
                            ? "Your model is on its way; its page shows the next step."
                            : "From a base model to an API in five steps."}
                    </p>
                </div>
                <Button asChild>
                    <Link href={`${FLOW}/discover`}>Discover a base</Link>
                </Button>
            </div>
            <ol className="flex flex-wrap gap-x-6 gap-y-1">
                {steps.map((step, index) => (
                    <li key={step} className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {index + 1}
                        </span>
                        {step}
                    </li>
                ))}
            </ol>
        </section>
    );
}

export function FlowHomePage() {
    const state = useFlowState();
    const live = state.models.filter((model) => model.deployed);
    const attending = state.models.flatMap((model) => {
        const reason = attention(model);
        const step = nextStep(state, model);
        if (reason) {
            return [{ model, detail: reason, href: modelHref(model.slug) }];
        }
        if (step && !step.label.startsWith("Try")) {
            return [{ model, detail: step.label, href: modelHref(model.slug) }];
        }
        return [];
    });
    return (
        <Page wide>
            <PageHeader title="Home" caption="What is live, what needs you, and where to start." />
            <p className="max-w-[56rem] text-muted-foreground">
                This prototype tests a smaller structure: no Training, Evaluations, Deployments or
                Pipelines pages. Training, scoring, deploying and the API live on each model and
                version page; Monitor lists every job. Follow the Journey (top right) from Discover
                to Feedback; actions change the fake data until you reload.
            </p>
            <GetStarted hasOwn={state.focus !== null} />
            <div className="grid gap-4 lg:grid-cols-2">
                <Section title="Live" caption={`${live.length} models answer requests.`} flush>
                    <ul className="divide-y">
                        {live.map((model) => {
                            const version = liveVersion(model);
                            return (
                                <ModelLine
                                    key={model.slug}
                                    model={model}
                                    href={modelHref(model.slug)}
                                    detail={`${version ? `v${version.number} · ${pct(version.scores?.[0])} · ` : ""}${sum(model.traffic).toLocaleString()} requests in 7 days`}
                                />
                            );
                        })}
                    </ul>
                </Section>
                <Section
                    title="Needs attention"
                    caption="A version beats live, failed, is training or waits for a step."
                    flush
                >
                    {attending.length === 0 ? (
                        <p className="px-panel pb-panel text-muted-foreground">
                            Nothing needs you.
                        </p>
                    ) : (
                        <ul className="divide-y">
                            {attending.map((item) => (
                                <ModelLine key={item.model.slug} {...item} />
                            ))}
                        </ul>
                    )}
                </Section>
            </div>
        </Page>
    );
}

function Fit({ entry }: { entry: CatalogEntry }) {
    return entry.downloaded ? (
        <StatusText tone="success">Downloaded</StatusText>
    ) : (
        <span className="text-muted-foreground">Not downloaded</span>
    );
}

export function FlowDiscoverPage() {
    return (
        <Page wide>
            <PageHeader
                title="Discover"
                caption="Approved open models you can download and build on."
            />
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Model</TableHead>
                            <TableHead className="text-right">Parameters</TableHead>
                            <TableHead className="text-right">Size</TableHead>
                            <TableHead className="text-right">Memory to serve</TableHead>
                            <TableHead>Licence</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {CATALOG.map((entry) => (
                            <TableRow key={entry.id}>
                                <TableCell>
                                    <Link
                                        href={catalogHref(entry.id)}
                                        className="flex items-center gap-3"
                                    >
                                        <PublisherLogo
                                            publisher={entry.publisher}
                                            name={entry.name}
                                        />
                                        <span className="flex min-w-0 flex-col">
                                            <span className="font-semibold hover:underline">
                                                {entry.name}
                                            </span>
                                            <span className="truncate text-sm text-muted-foreground">
                                                {entry.summary}
                                            </span>
                                        </span>
                                    </Link>
                                </TableCell>
                                <TableCell className="text-right">{entry.params}</TableCell>
                                <TableCell className="text-right">{entry.size}</TableCell>
                                <TableCell className="text-right">{entry.memory}</TableCell>
                                <TableCell>
                                    {entry.licence}
                                    {entry.serveOnly && (
                                        <span className="block text-sm text-muted-foreground">
                                            Serve-only
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell>
                                    <Fit entry={entry} />
                                </TableCell>
                                <TableCell className="text-right">
                                    <Button variant="secondary" size="sm" asChild>
                                        <Link href={`${FLOW}/models/new?base=${entry.id}`}>
                                            Add model
                                        </Link>
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Page>
    );
}

export function FlowCatalogPage() {
    const { id } = useParams({ strict: false }) as { id?: string };
    const toast = useToast();
    const entry = catalogEntry(id);
    if (!entry) {
        return (
            <Page>
                <p className="text-muted-foreground">Not in the catalogue.</p>
            </Page>
        );
    }
    return (
        <Page>
            <Crumbs
                items={[{ label: "Discover", href: `${FLOW}/discover` }, { label: entry.name }]}
            />
            <PageHeader
                title={entry.name}
                icon={<PublisherLogo publisher={entry.publisher} name={entry.name} size="lg" />}
                badge={<Badge variant="outline">Catalogue</Badge>}
                caption={entry.summary}
                actions={
                    <>
                        {!entry.downloaded && (
                            <Button
                                variant="outline"
                                onClick={() =>
                                    toast({
                                        title: "Not in the prototype",
                                        description: "Would download the weights.",
                                    })
                                }
                            >
                                Download
                            </Button>
                        )}
                        <Button asChild>
                            <Link href={`${FLOW}/models/new?base=${entry.id}`}>Add model</Link>
                        </Button>
                    </>
                }
            />
            {entry.downloaded && (
                <p className="rounded-md border bg-card px-3 py-2">
                    Downloaded: it is also a base model on this install.{" "}
                    <Link
                        href={modelHref(baseModelSlug(entry.name))}
                        className="text-primary hover:underline"
                    >
                        Open its model page →
                    </Link>
                </p>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
                <Section title="About">
                    <Facts
                        items={[
                            ["Publisher", entry.publisher],
                            ["Parameters", entry.params],
                            ["Context", entry.context],
                            ["Licence", entry.licence],
                            [
                                "Training",
                                entry.serveOnly
                                    ? "Serve-only: cannot be trained"
                                    : "LoRA and QLoRA",
                            ],
                        ]}
                    />
                </Section>
                <Section title="Runs here">
                    <Facts
                        items={[
                            ["Download", entry.size],
                            ["Memory to serve", entry.memory],
                            [
                                "gpu-a10-1 (24 GB)",
                                <StatusText key="g" tone="success">
                                    Serves and trains
                                </StatusText>,
                            ],
                            [
                                "cpu-pool",
                                <span key="c" className="text-muted-foreground">
                                    Serves slowly; cannot train
                                </span>,
                            ],
                        ]}
                    />
                </Section>
            </div>
        </Page>
    );
}

function BaseOption({
    entry,
    checked,
    onPick,
}: { entry: CatalogEntry; checked: boolean; onPick: () => void }) {
    return (
        <label
            className={cn(
                "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 hover:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                checked && "border-primary bg-accent hover:bg-accent",
            )}
        >
            <input
                type="radio"
                name="base"
                value={entry.id}
                checked={checked}
                onChange={onPick}
                className="sr-only"
            />
            <PublisherLogo publisher={entry.publisher} name={entry.name} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{entry.name}</span>
                <span className="truncate text-sm text-muted-foreground">
                    {`${entry.size} · ${entry.licence}${entry.serveOnly ? " · serve-only, no training" : ""}${entry.downloaded ? "" : " · downloads first"}`}
                </span>
            </span>
        </label>
    );
}

export function FlowAddModelPage() {
    const router = useRouter();
    const initial = catalogEntry(useSearchParam("base"))?.id ?? CATALOG[0].id;
    const [base, setBase] = useState(initial);
    const [name, setName] = useState("Steady Heron");
    const [avatar, setAvatar] = useState<AvatarChoice>(() => choiceFor("initials", "Steady Heron"));
    const [picking, setPicking] = useState(false);
    const shown = CATALOG.filter((entry) => entry.downloaded || entry.id === base);
    const display = name.trim() || "Untitled model";
    const apiName = display
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const rename = (next: string) => {
        setName(next);
        setAvatar((current) =>
            current.seed === choiceFor(current.style, name).seed
                ? choiceFor(current.style, next)
                : current,
        );
    };
    const create = (event: FormEvent) => {
        event.preventDefault();
        const slug = createModel(display, base, avatar);
        router.history.push(modelHref(slug));
    };
    return (
        <Page>
            <Crumbs items={[{ label: "Models", href: `${FLOW}/models` }, { label: "Add model" }]} />
            <PageHeader
                title="Add model"
                caption="Pick a base and a name. It starts as a chat assistant; data and training come next."
            />
            <form onSubmit={create} className="flex max-w-2xl flex-col gap-field">
                <fieldset className="flex flex-col gap-label">
                    <legend className="mb-2 font-medium">Base</legend>
                    <div className="grid gap-2">
                        {shown.map((entry) => (
                            <BaseOption
                                key={entry.id}
                                entry={entry}
                                checked={entry.id === base}
                                onPick={() => setBase(entry.id)}
                            />
                        ))}
                    </div>
                    <Link
                        href={`${FLOW}/discover`}
                        className="w-fit text-sm text-primary hover:underline"
                    >
                        More bases in Discover →
                    </Link>
                </fieldset>
                <div className="flex flex-col gap-label">
                    <Label htmlFor="add-name">Name</Label>
                    <div className="flex items-center gap-2">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    aria-label="Change avatar"
                                    aria-haspopup="dialog"
                                    onClick={() => setPicking(true)}
                                    className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                >
                                    <AvatarTile choice={avatar} name={display} size="md" />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Change avatar</TooltipContent>
                        </Tooltip>
                        <Input
                            id="add-name"
                            value={name}
                            onChange={(event) => rename(event.target.value)}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => rename(randomName())}
                        >
                            <Shuffle aria-hidden="true" />
                            Shuffle
                        </Button>
                    </div>
                    <span className="text-sm text-muted-foreground">
                        API name <span className="font-mono">{apiName || "model"}</span>
                    </span>
                </div>
                <div>
                    <Button type="submit" disabled={!name.trim()}>
                        Create
                    </Button>
                </div>
            </form>
            <PickerDialog
                open={picking}
                onOpenChange={setPicking}
                name={display}
                value={avatar}
                onUse={setAvatar}
            />
        </Page>
    );
}
