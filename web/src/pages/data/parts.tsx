import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Input,
    Link,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { LabelCount } from "~/api/client";
import { dataKeys } from "~/api/dataQueries";
import { keys, useAllModels, useSources } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { TAGS_HINT, Tags, editableTags } from "~/components/Tags";
import { modelPageHref } from "~/lib/modelLinks";
import { splitTags } from "../models/dialogs";
import { sourceNameProblem } from "./catalogue";

export type Described = { name: string; description: string; tags: string[] };

export type TrailLink = { label: string; href: string };

export function useDataRefresh() {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: keys.datasets }),
            client.invalidateQueries({ queryKey: keys.sources }),
            client.invalidateQueries({ queryKey: dataKeys.datasetFolders }),
            client.invalidateQueries({ queryKey: keys.allModels }),
            client.invalidateQueries({ queryKey: ["model"] }),
        ]);
}

export function useSourceNameProblem(name: string, except?: number): string | null {
    const sources = useSources();
    return sourceNameProblem(sources.data ?? [], name, except);
}

export function useModelNames() {
    const models = useAllModels();
    const names = new Map((models.data ?? []).map((row) => [row.key, row.name]));
    return (slug: string) => names.get(slug) ?? slug;
}

export function modelHref(slug: string): string {
    return modelPageHref(slug);
}

function TrailStep({
    caption,
    links,
    current,
    empty,
}: {
    caption: string;
    links: TrailLink[];
    current?: string;
    empty: string;
}) {
    const shown = links.slice(0, 3);
    const more = links.length - shown.length;
    return (
        <li className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-muted-foreground">{caption}</span>
            {current !== undefined ? (
                <span aria-current="page" className="truncate font-semibold">
                    {current}
                </span>
            ) : links.length === 0 ? (
                <span className="text-muted-foreground">{empty}</span>
            ) : (
                <span className="flex min-w-0 flex-wrap gap-x-2">
                    {shown.map((link) => (
                        <Link key={link.href} href={link.href} className="truncate text-primary">
                            {link.label}
                        </Link>
                    ))}
                    {more > 0 && <span className="text-muted-foreground">{`+${more}`}</span>}
                </span>
            )}
        </li>
    );
}

export function Trail({
    sources,
    datasets,
    models,
    current,
}: {
    sources: TrailLink[];
    datasets: TrailLink[];
    models: TrailLink[];
    current: "source" | "dataset";
}) {
    const steps = [
        <TrailStep
            key="source"
            caption={sources.length === 1 || current === "source" ? "Source" : "Sources"}
            links={sources}
            current={current === "source" ? sources[0]?.label : undefined}
            empty="None yet"
        />,
        <TrailStep
            key="dataset"
            caption={datasets.length === 1 || current === "dataset" ? "Dataset" : "Datasets"}
            links={datasets}
            current={current === "dataset" ? datasets[0]?.label : undefined}
            empty="None yet"
        />,
        <TrailStep
            key="models"
            caption={models.length === 1 ? "Model" : "Models"}
            links={models}
            empty="None yet"
        />,
    ];
    return (
        <nav aria-label="Lineage">
            <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {steps.map((step, index) => (
                    <Fragment key={step.key}>
                        {index > 0 && (
                            <ChevronRight
                                aria-hidden="true"
                                className="size-4 shrink-0 text-muted-foreground"
                            />
                        )}
                        {step}
                    </Fragment>
                ))}
            </ol>
        </nav>
    );
}

export function ItemHeader({
    title,
    icon,
    detail,
    trail,
    actions,
    about,
}: {
    title: ReactNode;
    icon?: ReactNode;
    detail?: ReactNode;
    trail?: ReactNode;
    actions?: ReactNode;
    about?: ReactNode;
}) {
    return (
        <header className="flex flex-col gap-3">
            {trail}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="flex min-w-0 items-center gap-2 text-2xl font-semibold">
                        {icon && (
                            <span aria-hidden="true" className="shrink-0 [&>svg]:size-5">
                                {icon}
                            </span>
                        )}
                        <span className="truncate">{title}</span>
                    </h2>
                    {detail && <p className="text-muted-foreground">{detail}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
            {about}
        </header>
    );
}

export function About({ item, onEdit }: { item: Described; onEdit: () => void }) {
    if (!item.description && item.tags.length === 0) {
        return (
            <div>
                <Button variant="link" className="h-auto px-0" onClick={onEdit}>
                    Add a description and tags
                </Button>
            </div>
        );
    }
    return (
        <div className="flex max-w-3xl flex-col gap-2">
            {item.description && (
                <p className="text-base whitespace-pre-line">{item.description}</p>
            )}
            <Tags tags={item.tags} />
        </div>
    );
}

export function EditDialog({
    item,
    open,
    noun,
    problem,
    onOpenChange,
    onSave,
}: {
    item: Described;
    open: boolean;
    noun: string;
    problem: (name: string) => string | null;
    onOpenChange: (open: boolean) => void;
    onSave: (body: Described) => Promise<unknown>;
}) {
    const [name, setName] = useState(item.name);
    const [description, setDescription] = useState(item.description);
    const [tags, setTags] = useState(editableTags(item.tags));
    useEffect(() => {
        if (open) {
            setName(item.name);
            setDescription(item.description);
            setTags(editableTags(item.tags));
        }
    }, [open, item]);
    const save = useMutation({
        mutationFn: () =>
            onSave({ name: name.trim(), description: description.trim(), tags: splitTags(tags) }),
        onSuccess: () => onOpenChange(false),
    });
    const clash = name.trim() ? problem(name) : null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!clash) {
                            save.mutate();
                        }
                    }}
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>{`Edit ${noun}`}</DialogTitle>
                        <DialogDescription>
                            Name, description and tags help people find it in search.
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        <Field id="data-edit-name" label="Name" error={clash}>
                            <Input
                                id="data-edit-name"
                                value={name}
                                maxLength={120}
                                aria-invalid={clash ? true : undefined}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Field>
                        <Field id="data-edit-description" label="Description">
                            <Textarea
                                id="data-edit-description"
                                value={description}
                                maxLength={1000}
                                rows={3}
                                onChange={(event) => setDescription(event.target.value)}
                            />
                        </Field>
                        <Field id="data-edit-tags" label="Tags" hint={TAGS_HINT}>
                            <Input
                                id="data-edit-tags"
                                value={tags}
                                onChange={(event) => setTags(event.target.value)}
                            />
                        </Field>
                    </FieldGroup>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || !!clash || save.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function DeleteAction({
    blocked,
    title,
    description,
    onConfirm,
}: {
    blocked: string | null;
    title: string;
    description: string;
    onConfirm: () => Promise<unknown>;
}) {
    if (blocked) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span>
                        <Button variant="outline" disabled>
                            Delete
                        </Button>
                    </span>
                </TooltipTrigger>
                <TooltipContent>{blocked}</TooltipContent>
            </Tooltip>
        );
    }
    return (
        <ConfirmDialog
            trigger={<Button variant="outline">Delete</Button>}
            title={title}
            description={description}
            confirmLabel="Delete"
            destructive
            onConfirm={onConfirm}
        />
    );
}

const SHOWN_LABELS = 12;

export function LabelBalance({ counts }: { counts: LabelCount[] }) {
    const total = counts.reduce((sum, item) => sum + item.rows, 0);
    const largest = counts[0]?.rows ?? 0;
    const shown = counts.slice(0, SHOWN_LABELS);
    const rest = counts.slice(SHOWN_LABELS);
    const restRows = rest.reduce((sum, item) => sum + item.rows, 0);
    if (total === 0) {
        return <p className="text-muted-foreground">No labelled rows yet.</p>;
    }
    return (
        <div className="flex flex-col gap-2">
            <table className="w-full table-fixed border-collapse">
                <caption className="sr-only">Rows per label</caption>
                <thead className="sr-only">
                    <tr>
                        <th scope="col">Label</th>
                        <th scope="col">Share</th>
                        <th scope="col">Rows</th>
                    </tr>
                </thead>
                <tbody>
                    {shown.map((item) => {
                        const share = item.rows / total;
                        return (
                            <tr key={item.label} className="group/bar h-7 hover:bg-secondary">
                                <th scope="row" className="w-[32%] pr-3 text-left font-normal">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span className="block truncate">{item.label}</span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-96 break-all">
                                            {item.label}
                                        </TooltipContent>
                                    </Tooltip>
                                </th>
                                <td className="pr-3">
                                    <div
                                        aria-hidden="true"
                                        className="h-3 rounded-r-sm bg-primary"
                                        style={{ width: `${(item.rows / largest) * 100}%` }}
                                    />
                                    <span className="sr-only">{`${(share * 100).toFixed(1)}%`}</span>
                                </td>
                                <td className="w-28 text-right text-muted-foreground tabular-nums group-hover/bar:text-foreground">
                                    {`${item.rows.toLocaleString()} · ${(share * 100).toFixed(0)}%`}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {rest.length > 0 && (
                <p className="text-sm text-muted-foreground tabular-nums">
                    {`${rest.length.toLocaleString()} more labels, ${restRows.toLocaleString()} rows`}
                </p>
            )}
        </div>
    );
}
