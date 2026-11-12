import { Globe } from "lucide-react";
import { Checkbox, Label, SearchInput } from "obp-ui";
import { useMemo, useState } from "react";
import type { KeyInfo, ModelAvatar, ModelRef } from "~/api/client";
import { useAllModels } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";

export type Choice = ModelRef & {
    name: string;
    avatar?: ModelAvatar | null;
    publisher?: string | null;
};

export const idOf = (ref: ModelRef) => `${ref.kind}:${ref.key}`;

export function refOf(id: string): ModelRef {
    const [kind, ...rest] = id.split(":");
    return { kind: kind === "base" ? "base" : "custom", key: rest.join(":") };
}

export function useChoices(): Choice[] {
    const { data } = useAllModels();
    return useMemo(
        () =>
            (data ?? [])
                .filter((row) => !row.teardown)
                .map((row) => ({
                    kind: row.kind,
                    key: row.key,
                    name: row.name,
                    avatar: row.avatar,
                    publisher: row.publisher,
                }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        [data],
    );
}

export function useChoiceIndex(): Map<string, Choice> {
    const choices = useChoices();
    return useMemo(() => new Map(choices.map((choice) => [idOf(choice), choice])), [choices]);
}

export function keyCovers(key: KeyInfo, scope: ModelRef): boolean {
    return (
        key.all_models ||
        key.models.some((model) => model.kind === scope.kind && model.key === scope.key)
    );
}

export function ModelMark({ choice }: { choice: Choice }) {
    return (
        <PublisherLogo
            publisher={choice.publisher}
            name={choice.name}
            custom={choice.kind === "custom"}
            avatar={choice.avatar}
            modelKey={choice.key}
            size="sm"
        />
    );
}

export function AllModelsLabel() {
    return (
        <span className="flex items-center gap-2">
            <span
                aria-hidden="true"
                className="flex size-5 shrink-0 items-center justify-center rounded-md border bg-background"
            >
                <Globe className="size-3.5 text-muted-foreground" />
            </span>
            All models
        </span>
    );
}

const SHOWN = 2;

export function ScopeCell({ item, index }: { item: KeyInfo; index: Map<string, Choice> }) {
    if (item.all_models) {
        return <AllModelsLabel />;
    }
    if (item.models.length === 0) {
        return <span className="text-muted-foreground">No access</span>;
    }
    const names = item.models.map((model) => model.name).join(", ");
    const more = item.models.length - SHOWN;
    return (
        <span className="flex min-w-0 items-center gap-3" title={names}>
            {item.models.slice(0, SHOWN).map((model) => (
                <span key={idOf(model)} className="flex min-w-0 items-center gap-2">
                    <ModelMark choice={index.get(idOf(model)) ?? model} />
                    <span className="truncate">{model.name}</span>
                </span>
            ))}
            {more > 0 && (
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{`+${more}`}</span>
            )}
        </span>
    );
}

function matches(choice: Choice, query: string): boolean {
    const wanted = query.trim().toLowerCase();
    return (
        !wanted ||
        choice.name.toLowerCase().includes(wanted) ||
        choice.key.toLowerCase().includes(wanted)
    );
}

export function ModelPicker({
    choices,
    picked,
    onToggle,
}: {
    choices: Choice[];
    picked: Set<string>;
    onToggle: (id: string, on: boolean) => void;
}) {
    const [query, setQuery] = useState("");
    if (choices.length === 0) {
        return <p className="text-muted-foreground">Add or download a model first.</p>;
    }
    const shown = choices.filter((choice) => matches(choice, query));
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
                <SearchInput
                    aria-label="Search models"
                    placeholder="Search models"
                    value={query}
                    onValueChange={setQuery}
                    className="min-w-0 flex-1"
                />
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {`${picked.size} picked`}
                </span>
            </div>
            <div className="flex h-56 flex-col divide-y overflow-y-auto rounded-md border">
                {shown.length === 0 && (
                    <p className="px-3 py-2 text-muted-foreground">No models match.</p>
                )}
                {shown.map((choice) => {
                    const id = idOf(choice);
                    return (
                        <Label
                            key={id}
                            className="flex items-center gap-3 px-3 py-1.5 font-normal hover:bg-secondary"
                        >
                            <Checkbox
                                checked={picked.has(id)}
                                onCheckedChange={(value) => onToggle(id, value === true)}
                            />
                            <ModelMark choice={choice} />
                            <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                            <span className="max-w-48 truncate font-mono text-sm text-muted-foreground">
                                {choice.key}
                            </span>
                        </Label>
                    );
                })}
            </div>
        </div>
    );
}
