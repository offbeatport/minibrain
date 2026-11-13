import { useParams, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import {
    Badge,
    Button,
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
import { type FormEvent, useEffect, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Page, Section, Stat } from "~/components/Section";
import { type Identity, NameAvatarField, newIdentity } from "~/components/avatar/NameAvatarField";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { DatasetPicker } from "./flowDatasetPicker";
import { useCan } from "./flowOverlays";
import {
    CATALOG,
    type CatalogEntry,
    FLOW,
    type InboxItem,
    RECIPES,
    type Recipe,
    applyUpdate,
    attachDataset,
    catalogEntry,
    createFromRecipe,
    createModel,
    dismiss,
    inbox,
    isInstalled,
    jobHref,
    jobOfVersion,
    markVisited,
    modelHref,
    openIntent,
    retryWithQLoRA,
    shortAgo,
    trainingVersion,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { Crumbs, ModelAvatar } from "./modelsFlowParts";

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function RecipeCard({ recipe, installed }: { recipe: Recipe; installed: boolean }) {
    const router = useRouter();
    const base = catalogEntry(recipe.base);
    const start = () => router.history.push(modelHref(createFromRecipe(recipe.id)));
    return (
        <li>
            <button
                type="button"
                onClick={start}
                className="flex h-full w-full flex-col gap-3 rounded-lg border bg-card p-panel text-left outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
                <span className="flex items-start justify-between gap-3">
                    <span className="font-semibold">{recipe.title}</span>
                    <Badge variant="outline">{recipe.task}</Badge>
                </span>
                <span className="text-muted-foreground">{recipe.summary}</span>
                <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                    <dt className="text-muted-foreground">Base</dt>
                    <dd className="truncate">
                        {base?.name}
                        {!installed && (
                            <span className="text-muted-foreground">{` · downloads ${base?.size}`}</span>
                        )}
                    </dd>
                    <dt className="text-muted-foreground">Sample</dt>
                    <dd className="truncate tabular-nums">
                        <span className="font-mono">{recipe.file}</span>
                        {` · ${count(recipe.rows)} rows`}
                    </dd>
                </dl>
            </button>
        </li>
    );
}

function Recipes({ title, caption }: { title: string; caption: string }) {
    const state = useFlowState();
    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                    <h2 className="text-lg font-semibold">{title}</h2>
                    <p className="text-sm text-muted-foreground">{caption}</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" asChild>
                        <Link href={`${FLOW}/discover`}>Discover bases</Link>
                    </Button>
                    <Button variant="outline" asChild>
                        <Link href={`${FLOW}/models/new`}>Add model</Link>
                    </Button>
                </div>
            </div>
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {RECIPES.map((recipe) => (
                    <RecipeCard
                        key={recipe.id}
                        recipe={recipe}
                        installed={isInstalled(state, recipe.base)}
                    />
                ))}
            </ul>
        </section>
    );
}

function Overview() {
    const state = useFlowState();
    const custom = state.models.filter((model) => model.kind === "custom");
    const onApi = state.models.filter((model) => model.deployed);
    const training = custom.filter((model) => trainingVersion(model)).length;
    const requests = sum(onApi.map((model) => sum(model.traffic)));
    return (
        <div className="flex flex-wrap gap-x-10 gap-y-3 rounded-lg border bg-card px-panel py-4">
            <Stat label="Your models" value={count(custom.length)} />
            <Stat label="Deployed" value={count(onApi.length)} />
            <Stat label="Requests, 7 days" value={count(requests)} />
            <Stat label="Training now" value={count(training)} />
            <Stat label="Datasets" value={count(state.datasets.length)} />
        </div>
    );
}

function InboxRow({ item }: { item: InboxItem }) {
    const router = useRouter();
    const toast = useToast();
    const can = useCan("builder") || item.action === "monitor";
    const act = () => {
        const slug = item.model?.slug ?? "";
        if (item.action === "make-live" && item.version !== undefined) {
            openIntent({
                kind: "make-live",
                slug,
                number: item.version,
                source: "inbox",
            });
        } else if (item.action === "rollout" && item.job !== undefined) {
            router.history.push(jobHref(item.job));
        } else if (item.action === "review") {
            router.history.push(`${FLOW}/feedback`);
        } else if (item.action === "monitor") {
            router.history.push(modelHref(slug, "monitoring"));
        } else if (item.action === "update" && item.variant) {
            applyUpdate(slug, item.variant);
            toast({ title: `${item.model?.name} updated`, tone: "success" });
        } else if (item.action === "retry" && item.version !== undefined) {
            if (item.label === "Open") {
                router.history.push(versionHref(slug, item.version));
                return;
            }
            const number = retryWithQLoRA(slug, item.version);
            toast({
                title: `v${number} of ${item.model?.name} is training with QLoRA`,
                description: `Same data and settings as v${item.version}, in 4-bit.`,
                tone: "success",
                action: {
                    label: "Watch",
                    onClick: () => {
                        const job = jobOfVersion(slug, number);
                        if (job) {
                            router.history.push(jobHref(job));
                        }
                    },
                },
            });
        }
    };
    return (
        <li className="flex items-center gap-3 px-panel py-3">
            {item.model ? (
                <ModelAvatar model={item.model} />
            ) : (
                <span aria-hidden="true" className="size-8 shrink-0" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
                {item.job !== undefined ? (
                    <Link href={jobHref(item.job)} className="truncate font-medium hover:underline">
                        {item.text}
                    </Link>
                ) : item.model && item.version !== undefined ? (
                    <Link
                        href={versionHref(item.model.slug, item.version)}
                        className="truncate font-medium hover:underline"
                    >
                        {item.text}
                    </Link>
                ) : (
                    <span className="truncate font-medium">{item.text}</span>
                )}
                <span className="truncate text-sm text-muted-foreground">{item.detail}</span>
            </span>
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {shortAgo(item)}
            </span>
            {can ? (
                <Button
                    variant={item.action === "make-live" ? "default" : "outline"}
                    className="w-40 shrink-0"
                    onClick={act}
                >
                    {item.label}
                </Button>
            ) : (
                <span className="w-40 shrink-0" />
            )}
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Dismiss: ${item.text}`}
                        onClick={() => dismiss(item.id)}
                    >
                        <X />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Dismiss</TooltipContent>
            </Tooltip>
        </li>
    );
}

function Inbox() {
    const state = useFlowState();
    const items = inbox(state);
    return (
        <Section title="Inbox" caption="Decisions waiting across your models, newest first." flush>
            {items.length === 0 ? (
                <p className="px-panel py-6 text-muted-foreground">Nothing needs you.</p>
            ) : (
                <ul className="divide-y">
                    {items.map((item) => (
                        <InboxRow key={item.id} item={item} />
                    ))}
                </ul>
            )}
        </Section>
    );
}

export function FlowHomePage() {
    const state = useFlowState();
    const empty = !state.models.some((model) => model.kind === "custom");
    if (empty) {
        return (
            <Page wide>
                <PageHeader
                    title="Home"
                    caption="No models yet. A recipe creates one with sample data attached, ready to train."
                />
                <Recipes
                    title="Start from a recipe"
                    caption="Each names the task, the base it trains and the sample data it brings. Swap in your own data later."
                />
            </Page>
        );
    }
    return (
        <Page wide>
            <PageHeader title="Home" caption="What needs you across your models." />
            <Overview />
            <Inbox />
            <Recipes
                title="Recipes"
                caption="Start another model from a use case, with sample data attached."
            />
        </Page>
    );
}

function Fit({ entry }: { entry: CatalogEntry }) {
    const state = useFlowState();
    return isInstalled(state, entry.id) ? (
        <StatusText tone="success">Installed</StatusText>
    ) : (
        <span className="text-muted-foreground">Not downloaded</span>
    );
}

export function FlowDiscoverPage() {
    return (
        <Page wide>
            <PageHeader title="Discover" caption="Open models you can add." />
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
                                        href={modelHref(entry.id)}
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
                                <TableCell>{entry.licence}</TableCell>
                                <TableCell>
                                    <Fit entry={entry} />
                                </TableCell>
                                <TableCell className="text-right">
                                    <Button variant="secondary" asChild>
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
    const router = useRouter();
    useEffect(() => {
        router.history.replace(modelHref(id ?? ""));
    }, [router, id]);
    return null;
}

function BaseOption({
    entry,
    checked,
    installed,
    onPick,
}: {
    entry: CatalogEntry;
    checked: boolean;
    installed: boolean;
    onPick: () => void;
}) {
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
                    {`${entry.size} · ${entry.licence}${entry.serveOnly ? " · serve-only, no training" : ""}${installed ? "" : " · downloads first"}`}
                </span>
            </span>
        </label>
    );
}

export function FlowAddModelPage() {
    const router = useRouter();
    const initial = catalogEntry(useSearchParam("base"))?.id ?? CATALOG[0].id;
    const [base, setBase] = useState(initial);
    const state = useFlowState();
    const wanted = useSearchParam("dataset");
    const [dataset, setDataset] = useState<string | null>(
        () => state.datasets.find((item) => item.slug === wanted)?.slug ?? null,
    );
    const names = new Set(state.models.map((model) => model.name.toLowerCase()));
    const taken = (name: string) => names.has(name.toLowerCase());
    const [identity, setIdentity] = useState<Identity>(() => newIdentity(taken));
    const installed = CATALOG.filter((entry) => isInstalled(state, entry.id));
    const shown =
        installed.length === 0
            ? CATALOG.slice(0, 3)
            : CATALOG.filter((entry) => entry.id === base || installed.includes(entry));
    const display = identity.name.trim() || "Untitled model";
    const apiName = display
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const create = (event: FormEvent) => {
        event.preventDefault();
        const slug = createModel(display, base, identity.avatar);
        if (dataset) {
            attachDataset(slug, dataset);
        }
        markVisited("infra-add");
        router.history.push(modelHref(slug));
    };
    return (
        <Page>
            <Crumbs items={[{ label: "Models", href: `${FLOW}/models` }, { label: "Add model" }]} />
            <PageHeader title="Add model" caption="Pick a base, its dataset and a name." />
            <form onSubmit={create} className="flex max-w-2xl flex-col gap-field">
                <fieldset className="flex flex-col gap-label">
                    <legend className="mb-2 font-medium">Base</legend>
                    <div className="grid gap-2">
                        {shown.map((entry) => (
                            <BaseOption
                                key={entry.id}
                                entry={entry}
                                checked={entry.id === base}
                                installed={isInstalled(state, entry.id)}
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
                <fieldset className="flex flex-col gap-label">
                    <legend className="mb-2 font-medium">
                        Dataset{" "}
                        <span className="font-normal text-muted-foreground">· optional</span>
                    </legend>
                    <DatasetPicker value={dataset} onChange={setDataset} later />
                </fieldset>
                <NameAvatarField
                    id="add-name"
                    value={identity}
                    onChange={setIdentity}
                    taken={taken}
                >
                    <span className="text-sm text-muted-foreground">
                        API name <span className="font-mono">{apiName || "model"}</span>
                    </span>
                </NameAvatarField>
                <div>
                    <Button type="submit" disabled={!identity.name.trim()}>
                        Add model
                    </Button>
                </div>
            </form>
        </Page>
    );
}
