import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge, Button, ConfirmDialog, Input, Label, Link } from "obp-ui";
import { type FormEvent, useState } from "react";
import { type MinibrainSummary, api, succeed, unwrap } from "~/api/client";
import { keys, useMinibrains } from "~/api/queries";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section } from "~/components/Section";
import { percent } from "~/lib/format";

function CreateMinibrain() {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [name, setName] = useState("");
    const create = useMutation({
        mutationFn: (value: string) =>
            unwrap(api.POST("/api/minibrains", { body: { name: value } })),
        onSuccess: async (minibrain) => {
            await queryClient.invalidateQueries({ queryKey: keys.minibrains });
            router.history.push(`/data?minibrain=${encodeURIComponent(minibrain.slug)}`);
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim()) {
            create.mutate(name.trim());
        }
    };
    return (
        <Section
            title="New minibrain"
            caption="Start with a Classify task: text in, one label out."
        >
            <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-2">
                <div className="flex min-w-64 flex-1 flex-col gap-1">
                    <Label htmlFor="minibrain-name">Name</Label>
                    <Input
                        id="minibrain-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Support triage"
                    />
                </div>
                <Button type="submit" disabled={!name.trim() || create.isPending}>
                    Create
                </Button>
            </form>
            <div className="mt-2">
                <ErrorLine error={create.error} />
            </div>
        </Section>
    );
}

function DeleteMinibrain({ item }: { item: MinibrainSummary }) {
    const queryClient = useQueryClient();
    const remove = useMutation({
        mutationFn: () =>
            succeed(
                api.DELETE("/api/minibrains/{slug}", { params: { path: { slug: item.slug } } }),
            ),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.minibrains }),
    });
    return (
        <ConfirmDialog
            trigger={
                <Button variant="ghost" size="xs">
                    Delete
                </Button>
            }
            title={`Delete ${item.name}?`}
            description="This removes its data, versions, adapters and API keys from this install."
            confirmLabel="Delete"
            destructive
            onConfirm={() => remove.mutateAsync()}
        />
    );
}

const COLUMNS: ColumnDef<MinibrainSummary, unknown>[] = [
    {
        header: "Name",
        id: "name",
        cell: ({ row }) => (
            <Link
                className="font-semibold text-primary"
                href={`/evaluations?minibrain=${encodeURIComponent(row.original.slug)}`}
            >
                {row.original.name}
            </Link>
        ),
    },
    {
        header: "Task",
        id: "task",
        cell: ({ row }) => (row.original.task === "classify" ? "Classify" : row.original.task),
    },
    {
        header: "Base",
        id: "base",
        cell: ({ row }) => <span className="font-mono">{row.original.base_model}</span>,
    },
    {
        header: "Serving",
        id: "serving",
        cell: ({ row }) =>
            row.original.current_version === null ? "–" : `v${row.original.current_version}`,
    },
    {
        header: "Held-out",
        id: "accuracy",
        cell: ({ row }) => percent(row.original.current_accuracy),
    },
    {
        header: "Jobs",
        id: "jobs",
        cell: ({ row }) =>
            row.original.active_jobs > 0 ? <Badge variant="info">Running</Badge> : "–",
    },
    { header: "", id: "delete", cell: ({ row }) => <DeleteMinibrain item={row.original} /> },
];

export function ModelsPage() {
    const { data } = useMinibrains();
    return (
        <Page>
            <PageHeader
                title="Models"
                caption="Every minibrain on this install and the version it serves."
            />
            <Section title="Minibrains">
                <DataTable
                    columns={COLUMNS}
                    rows={data ?? []}
                    empty="No minibrains yet. Create one below."
                />
            </Section>
            <CreateMinibrain />
        </Page>
    );
}
