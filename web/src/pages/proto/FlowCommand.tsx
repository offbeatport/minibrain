import { useRouter } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, Input, KbdHint, cn } from "obp-ui";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
    FLOW,
    type FlowState,
    bestCandidate,
    datasetHref,
    jobHref,
    modelHref,
    nextNumber,
    openIntent,
    points,
    scoreDelta,
    useFlowState,
    versionHref,
    versionName,
    versionState,
} from "./modelsFlowData";
import { openConnect } from "./modelsFlowParts";

type Group = "Actions" | "Models" | "Versions" | "Data" | "Jobs";

type Command = {
    id: string;
    group: Group;
    label: string;
    detail: string;
    text: string;
    run: () => void;
};

const GROUPS: Group[] = ["Actions", "Models", "Versions", "Data", "Jobs"];
const LIMITS: Record<Group, number> = {
    Actions: 6,
    Models: 6,
    Versions: 8,
    Data: 4,
    Jobs: 4,
};
const IDLE: Group[] = ["Actions", "Models"];

function commandsOf(state: FlowState, go: (href: string) => void): Command[] {
    const custom = state.models.filter((model) => model.kind === "custom");
    const actions: Command[] = [
        ...custom.flatMap((model) => {
            const candidate = bestCandidate(model);
            if (!candidate || model.live === null) {
                return [];
            }
            return [
                {
                    id: `live:${model.slug}`,
                    group: "Actions" as const,
                    label: `Make live v${candidate.number}`,
                    detail: `${model.name} · beats live ${points(scoreDelta(model, candidate) ?? 0)}`,
                    text: `make v${candidate.number} live make live v${candidate.number} ${model.name} ${model.slug}`,
                    run: () =>
                        openIntent({
                            kind: "make-live",
                            slug: model.slug,
                            number: candidate.number,
                        }),
                },
            ];
        }),
        {
            id: "add",
            group: "Actions",
            label: "Add model",
            detail: "Pick a base and a name",
            text: "add model new create",
            run: () => go(`${FLOW}/models/new`),
        },
        {
            id: "playground",
            group: "Actions",
            label: "Open Playground",
            detail: "Chat with any model or version",
            text: "open playground chat try",
            run: () => go(`${FLOW}/playground`),
        },
        ...custom.map((model) => ({
            id: `key:${model.slug}`,
            group: "Actions" as const,
            label: `New API key for ${model.name}`,
            detail: "Shown once",
            text: `new api key create ${model.name} ${model.slug}`,
            run: () => go(`${modelHref(model.slug, "keys")}?new=1`),
        })),
        ...custom.map((model) => ({
            id: `connect:${model.slug}`,
            group: "Actions" as const,
            label: `Connect to ${model.name}`,
            detail: "Base URL, model name and code",
            text: `connect api curl python ${model.name} ${model.slug}`,
            run: () => openConnect(model.slug),
        })),
        ...custom
            .filter((model) => model.dataset && !model.serveOnly)
            .map((model) => ({
                id: `train:${model.slug}`,
                group: "Actions" as const,
                label: `Train v${nextNumber(model)} of ${model.name}`,
                detail: "Training tab",
                text: `train v${nextNumber(model)} ${model.name} ${model.slug}`,
                run: () => go(modelHref(model.slug, "training")),
            })),
    ];
    const models: Command[] = state.models.map((model) => ({
        id: `model:${model.slug}`,
        group: "Models",
        label: model.name,
        detail: model.kind === "base" ? "Base model" : `On ${model.base}`,
        text: `${model.name} ${model.slug} ${model.base ?? ""}`,
        run: () => go(modelHref(model.slug)),
    }));
    const versions: Command[] = custom.flatMap((model) =>
        [...model.versions]
            .sort((a, b) => b.number - a.number)
            .map((version) => ({
                id: `version:${model.slug}:${version.number}`,
                group: "Versions" as const,
                label: `${model.name} ${versionName(version)}`,
                detail: versionState(model, version).label,
                text: `${model.name} ${model.slug} v${version.number} ${model.slug}@${version.number} ${version.kind === "prompt" ? "baseline" : ""}`,
                run: () => go(versionHref(model.slug, version.number)),
            })),
    );
    const datasets: Command[] = state.datasets.map((item) => ({
        id: `data:${item.slug}`,
        group: "Data",
        label: item.name,
        detail: `${item.file} · v${item.version}`,
        text: `${item.name} ${item.file} dataset data`,
        run: () => go(datasetHref(item.slug)),
    }));
    const jobs: Command[] = state.jobs.map((job) => {
        const owner = state.models.find((model) => model.slug === job.model)?.name ?? job.model;
        const what = `${job.kind}${job.version === null ? "" : ` v${job.version}`} of ${owner}`;
        return {
            id: `job:${job.id}`,
            group: "Jobs",
            label: `Job #${job.id}`,
            detail: `${what.charAt(0).toUpperCase()}${what.slice(1)} · ${job.status}`,
            text: `job #${job.id} ${job.id} ${what} ${job.status}`,
            run: () => go(jobHref(job.id)),
        };
    });
    return [...actions, ...models, ...versions, ...datasets, ...jobs];
}

function filtered(commands: Command[], query: string): Command[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return GROUPS.flatMap((group) => {
        const own = commands.filter((command) => command.group === group);
        if (terms.length === 0) {
            return IDLE.includes(group) ? own.slice(0, 5) : [];
        }
        return own
            .filter((command) => terms.every((term) => command.text.toLowerCase().includes(term)))
            .slice(0, LIMITS[group]);
    });
}

export function CommandPalette({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const state = useFlowState();
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const go = (href: string) => router.history.push(href);
    const commands = commandsOf(state, go);
    const shown = filtered(commands, query);
    const current = Math.min(active, Math.max(0, shown.length - 1));
    useEffect(() => {
        if (!open) {
            setQuery("");
            setActive(0);
        }
    }, [open]);
    useEffect(() => {
        document.getElementById(`cmd-${shown[current]?.id}`)?.scrollIntoView({ block: "nearest" });
    });
    const run = (command: Command | undefined) => {
        if (!command) {
            return;
        }
        onOpenChange(false);
        command.run();
    };
    const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
        const moves: Record<string, () => void> = {
            ArrowDown: () => setActive((current + 1) % Math.max(1, shown.length)),
            ArrowUp: () => setActive((current - 1 + shown.length) % Math.max(1, shown.length)),
            Home: () => setActive(0),
            End: () => setActive(Math.max(0, shown.length - 1)),
            Enter: () => run(shown[current]),
        };
        const move = moves[event.key];
        if (move) {
            event.preventDefault();
            move();
        }
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
            >
                <DialogTitle className="sr-only">Search and run</DialogTitle>
                <div className="relative border-b p-3">
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-5.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                        aria-controls="flow-commands"
                        aria-label="Search models, versions, data, jobs and actions"
                        placeholder="Search models, versions (support v5), data, jobs, actions"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setActive(0);
                        }}
                        onKeyDown={onKey}
                        className="pl-8"
                    />
                </div>
                <p aria-live="polite" className="sr-only">
                    {shown[current]
                        ? `${shown[current].label}, ${shown[current].group}, ${current + 1} of ${shown.length}`
                        : "No results"}
                </p>
                <div id="flow-commands" className="max-h-[min(28rem,60vh)] overflow-y-auto py-1">
                    {shown.length === 0 && (
                        <p className="px-4 py-6 text-muted-foreground">
                            Nothing matches. Try a model name, a version like v5, or a job number.
                        </p>
                    )}
                    {GROUPS.map((group) => {
                        const items = shown.filter((command) => command.group === group);
                        if (items.length === 0) {
                            return null;
                        }
                        return (
                            <section key={group} aria-label={group} className="pb-1">
                                <h3 className="px-4 pt-2 pb-1 text-sm font-normal text-muted-foreground">
                                    {group}
                                </h3>
                                {items.map((command) => {
                                    const index = shown.indexOf(command);
                                    return (
                                        <button
                                            type="button"
                                            key={command.id}
                                            id={`cmd-${command.id}`}
                                            tabIndex={-1}
                                            aria-current={index === current ? "true" : undefined}
                                            onMouseMove={() => setActive(index)}
                                            onClick={() => run(command)}
                                            className={cn(
                                                "flex min-h-8 w-full cursor-pointer items-center gap-3 px-4 py-1.5 text-left outline-none",
                                                index === current && "bg-secondary",
                                            )}
                                        >
                                            <span className="truncate">{command.label}</span>
                                            <span className="ml-auto shrink-0 truncate text-sm text-muted-foreground">
                                                {command.detail}
                                            </span>
                                        </button>
                                    );
                                })}
                            </section>
                        );
                    })}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2">
                    <KbdHint keys={["↑", "↓"]}>move</KbdHint>
                    <KbdHint keys={["Enter"]}>open or run</KbdHint>
                    <KbdHint keys={["Esc"]}>close</KbdHint>
                </div>
            </DialogContent>
        </Dialog>
    );
}
