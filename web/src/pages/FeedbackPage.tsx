import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft } from "lucide-react";
import { Badge, Button, CheckboxSelect, DataGrid, EmptyState, Link, SearchInput } from "obp-ui";
import { useMemo } from "react";
import { type FeedbackInfo, useFeedbackFacets, useFeedbackList } from "~/api/feedbackQueries";
import { useModels } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { modelOption } from "~/components/PublisherLogo";
import { ErrorLine, Page } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import {
    FEEDBACK_PATH,
    FEEDBACK_STATUSES,
    feedbackStatusLabel,
    feedbackStatusVariant,
    fromLabel,
    signalLabel,
} from "~/lib/feedback";
import { listHref, splitList, useListSearch } from "~/lib/listSearch";
import { FeedbackReview } from "./feedback/FeedbackReview";
import { Updated } from "./models/MyModels";

const KEYS = ["model", "status", "assignee", "q", "item"] as const;
const ASSIGNEES = [
    { value: "me", label: "Me" },
    { value: "none", label: "No one" },
];

function Muted({ children }: { children: string }) {
    return <span className="text-muted-foreground">{children}</span>;
}

export function FeedbackStatusBadge({ item }: { item: FeedbackInfo }) {
    return (
        <Badge variant={feedbackStatusVariant(item.status)}>
            {feedbackStatusLabel(item.status)}
        </Badge>
    );
}

function StatusCell({ item }: { item: FeedbackInfo }) {
    const signal = signalLabel(item.signal);
    return (
        <span className="flex items-center gap-2">
            <FeedbackStatusBadge item={item} />
            {signal && (
                <StatusText tone={item.signal === "conflict" ? "warning" : "info"}>
                    {signal}
                </StatusText>
            )}
        </span>
    );
}

function feedbackColumns(href: (item: FeedbackInfo) => string): ColumnDef<FeedbackInfo, unknown>[] {
    return [
        {
            id: "input",
            header: "Input",
            enableHiding: false,
            cell: ({ row }) => (
                <Link
                    href={href(row.original)}
                    className="block max-w-72 truncate font-semibold text-foreground"
                >
                    {row.original.input}
                </Link>
            ),
        },
        {
            id: "answer",
            header: "Model's answer",
            cell: ({ row }) =>
                row.original.output ? (
                    <span className="block max-w-40 truncate">{row.original.output}</span>
                ) : (
                    <Muted>Not sent</Muted>
                ),
        },
        {
            id: "suggestion",
            header: "Suggested answer",
            cell: ({ row }) =>
                row.original.suggestion ? (
                    <span className="block max-w-40 truncate">{row.original.suggestion}</span>
                ) : (
                    <Muted>None given</Muted>
                ),
        },
        {
            id: "status",
            header: "Status",
            cell: ({ row }) => <StatusCell item={row.original} />,
        },
        {
            id: "model",
            header: "Model",
            cell: ({ row }) => (
                <span className="block max-w-48 truncate">{row.original.model_name}</span>
            ),
        },
        {
            id: "assignee",
            header: "Assigned to",
            cell: ({ row }) =>
                row.original.assignee ? (
                    <span className="block truncate">{row.original.assignee}</span>
                ) : (
                    <Muted>No one</Muted>
                ),
        },
        {
            id: "origin",
            header: "From",
            cell: ({ row }) => fromLabel(row.original),
        },
        {
            id: "version",
            header: "Version",
            cell: ({ row }) => (
                <span className="tabular-nums">
                    {row.original.version === null ? "–" : `v${row.original.version}`}
                </span>
            ),
        },
        {
            id: "received",
            header: "Received",
            cell: ({ row }) => <Updated value={row.original.created_at} />,
        },
    ];
}

function itemId(value: string | undefined): number | null {
    const id = Number(value);
    return value && Number.isInteger(id) && id > 0 ? id : null;
}

export function FeedbackPage() {
    const { search, update, open } = useListSearch(FEEDBACK_PATH, KEYS);
    const owned = useModels();
    const models = splitList(search.model);
    const statuses = splitList(search.status);
    const assignees = splitList(search.assignee);
    const filter = { model: models, status: statuses, assignee: assignees, q: search.q };
    const list = useFeedbackList(filter);
    const facets = useFeedbackFacets(filter);
    const selected = itemId(search.item);
    const filtering = models.length + statuses.length + assignees.length > 0 || Boolean(search.q);
    const columns = useMemo(
        () =>
            feedbackColumns((item) =>
                listHref(FEEDBACK_PATH, { ...search, item: String(item.id) }),
            ),
        [search],
    );
    const ids = list.rows.map((item) => item.id);
    const firstPending = list.rows.find((item) => item.status === "pending");
    const clear = () => update({ model: "", status: "", assignee: "", q: "" });
    const show = (id: number | null) =>
        id === null ? update({ item: "" }) : open({ item: String(id) });
    const modelOptions = (owned.data ?? []).map((item) =>
        modelOption({
            value: item.slug,
            label: item.name,
            count: facets.data?.models[item.slug] ?? 0,
        }),
    );
    const statusOptions = FEEDBACK_STATUSES.map((status) => ({
        value: status,
        label: feedbackStatusLabel(status),
        count: facets.data?.statuses[status] ?? 0,
    }));
    if (selected !== null) {
        return (
            <Page>
                <Link
                    href={listHref(FEEDBACK_PATH, { ...search, item: "" })}
                    className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                    <ChevronLeft className="size-4" />
                    Feedback
                </Link>
                <FeedbackReview
                    key={selected}
                    id={selected}
                    ids={ids}
                    hasMore={list.hasMore}
                    loadMore={list.loadMore}
                    onOpen={show}
                />
            </Page>
        );
    }
    return (
        <Page wide>
            <PageHeader
                title="Feedback"
                caption="Answers people marked right or wrong, from the playground and the API. Accepted answers join the model's next training data."
                actions={
                    <Button
                        onClick={() => firstPending && show(firstPending.id)}
                        disabled={!firstPending}
                    >
                        Review next
                    </Button>
                }
            />
            <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                    aria-label="Search feedback"
                    placeholder="Search inputs, answers and comments"
                    value={search.q ?? ""}
                    onValueChange={(q) => update({ q })}
                    className="w-full min-w-48 max-w-xs flex-1"
                />
                <CheckboxSelect
                    label="Model"
                    allLabel="All models"
                    noun="models"
                    options={modelOptions}
                    value={models}
                    onValueChange={(next) => update({ model: next.join(",") })}
                />
                <CheckboxSelect
                    label="Status"
                    allLabel="All statuses"
                    noun="statuses"
                    options={statusOptions}
                    value={statuses}
                    onValueChange={(next) => update({ status: next.join(",") })}
                />
                <CheckboxSelect
                    label="Assigned to"
                    allLabel="Anyone"
                    noun="people"
                    options={ASSIGNEES}
                    value={assignees}
                    onValueChange={(next) => update({ assignee: next.join(",") })}
                />
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        Clear filters
                    </Button>
                )}
            </div>
            <ErrorLine error={list.error} />
            <DataGrid
                columns={columns}
                rows={list.rows}
                getRowId={(item) => String(item.id)}
                loading={list.isLoading}
                sortable={false}
                storageKey="minibrain.feedback.columns"
                columnPicker
                hiddenColumns={["assignee", "origin", "version", "received"]}
                hasMore={list.hasMore}
                loadingMore={list.loadingMore}
                onLoadMore={list.loadMore}
                total={list.total}
                onOpen={(item) => show(item.id)}
                rowLabel={(item) =>
                    `${item.input}, ${item.model_name}, ${feedbackStatusLabel(item.status)}`
                }
                empty={
                    filtering ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-muted-foreground">
                                No feedback matches these filters.
                            </p>
                            <Button variant="outline" onClick={clear}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        <EmptyState title="No feedback yet">
                            Mark answers right or wrong in the{" "}
                            <Link href="/playground" className="text-primary hover:underline">
                                Playground
                            </Link>
                            , or send them from your app with{" "}
                            <span className="font-mono">POST /v1/feedback</span>.
                        </EmptyState>
                    )
                }
                minWidth="min-w-[880px]"
            />
        </Page>
    );
}
