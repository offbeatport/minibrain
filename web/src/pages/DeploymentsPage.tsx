import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, Input, Label } from "obp-ui";
import { type FormEvent, useState } from "react";
import { type KeyCreated, type KeyInfo, api, succeed, unwrap } from "~/api/client";
import { keys, useKeys, useMinibrain } from "~/api/queries";
import { DataTable } from "~/components/DataTable";
import { ScopedPage } from "~/components/PageHeader";
import { ErrorLine, Section } from "~/components/Section";
import { dateTime, percent } from "~/lib/format";

function Code({ children }: { children: string }) {
    return (
        <pre className="overflow-x-auto rounded-md border bg-secondary p-3 font-mono text-sm">
            {children}
        </pre>
    );
}

function snippets(baseUrl: string, model: string, secret: string) {
    const curl = [
        `curl ${baseUrl}/chat/completions \\`,
        `  -H "Authorization: Bearer ${secret}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model": "${model}", "messages": [{"role": "user", "content": "I was charged twice"}]}'`,
    ].join("\n");
    const python = [
        "from openai import OpenAI",
        "",
        `client = OpenAI(base_url="${baseUrl}", api_key="${secret}")`,
        "reply = client.chat.completions.create(",
        `    model="${model}",`,
        '    messages=[{"role": "user", "content": "I was charged twice"}],',
        ")",
        "print(reply.choices[0].message.content)",
    ].join("\n");
    return { curl, python };
}

function KeysSection({ slug, onCreated }: { slug: string; onCreated: (key: KeyCreated) => void }) {
    const queryClient = useQueryClient();
    const { data } = useKeys(slug);
    const [name, setName] = useState("");
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.keys(slug) });
    const create = useMutation({
        mutationFn: (value: string) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/keys", {
                    params: { path: { slug } },
                    body: { name: value },
                }),
            ),
        onSuccess: (key) => {
            onCreated(key);
            setName("");
            return refresh();
        },
    });
    const remove = useMutation({
        mutationFn: (keyId: number) =>
            succeed(
                api.DELETE("/api/minibrains/{slug}/keys/{key_id}", {
                    params: { path: { slug, key_id: keyId } },
                }),
            ),
        onSuccess: refresh,
    });
    const columns: ColumnDef<KeyInfo, unknown>[] = [
        { header: "Name", accessorKey: "name" },
        {
            header: "Key",
            accessorKey: "prefix",
            cell: (info) => <span className="font-mono">{String(info.getValue())}…</span>,
        },
        {
            header: "Created",
            accessorKey: "created_at",
            cell: (info) => dateTime(String(info.getValue())),
        },
        {
            header: "Last used",
            accessorKey: "last_used_at",
            cell: (info) => dateTime(info.getValue() as string | null),
        },
        {
            header: "",
            id: "delete",
            cell: ({ row }) => (
                <Button variant="ghost" size="xs" onClick={() => remove.mutate(row.original.id)}>
                    Revoke
                </Button>
            ),
        },
    ];
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate(name.trim() || "default");
    };
    return (
        <Section
            title="API keys"
            caption="A key only reaches this minibrain. The full key is shown once."
        >
            <form onSubmit={submit} className="mb-3 flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                        id="key-name"
                        className="w-56"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="helpdesk-app"
                    />
                </div>
                <Button type="submit" disabled={create.isPending}>
                    Create key
                </Button>
            </form>
            <ErrorLine error={create.error ?? remove.error} />
            <DataTable columns={columns} rows={data ?? []} empty="No keys yet." />
        </Section>
    );
}

function Deployment({ slug }: { slug: string }) {
    const { data: detail } = useMinibrain(slug);
    const [created, setCreated] = useState<KeyCreated | null>(null);
    if (!detail) {
        return null;
    }
    const baseUrl = `${window.location.origin}/v1`;
    const model = detail.models[0] ?? slug;
    const code = snippets(baseUrl, model, created?.secret ?? "YOUR_KEY");
    return (
        <>
            <Section
                title="Endpoint"
                caption="OpenAI-compatible. Point any OpenAI client at this base URL."
            >
                <div className="flex flex-col gap-3 text-sm">
                    <div>
                        <div className="text-muted-foreground">Serving</div>
                        <div>
                            {detail.current_version === null
                                ? "Nothing yet: promote a version on the Evaluations page."
                                : `v${detail.current_version} · ${percent(detail.current_accuracy)} held-out accuracy`}
                        </div>
                    </div>
                    <div>
                        <div className="text-muted-foreground">Base URL</div>
                        <div className="font-mono">{baseUrl}</div>
                    </div>
                    <div>
                        <div className="text-muted-foreground">Model names</div>
                        {detail.models.length === 0 ? (
                            <div>No ready version yet.</div>
                        ) : (
                            <div className="flex flex-wrap gap-x-4 font-mono">
                                {detail.models.map((name) => (
                                    <span key={name}>{name}</span>
                                ))}
                            </div>
                        )}
                        <p className="text-muted-foreground">
                            <span className="font-mono">{slug}</span> follows the current version;{" "}
                            <span className="font-mono">{slug}@N</span> pins one.
                        </p>
                    </div>
                </div>
            </Section>
            <KeysSection slug={slug} onCreated={setCreated} />
            {created && (
                <div className="rounded-lg border border-success/40 bg-success-soft p-4 text-sm">
                    <div className="font-semibold">New key for {created.name}</div>
                    <div className="mt-1 break-all font-mono">{created.secret}</div>
                    <p className="mt-1 text-muted-foreground">
                        Copy it now; it is not shown again.
                    </p>
                </div>
            )}
            <Section title="Examples">
                <div className="flex flex-col gap-3">
                    <Code>{code.curl}</Code>
                    <Code>{code.python}</Code>
                </div>
            </Section>
        </>
    );
}

export function DeploymentsPage() {
    return (
        <ScopedPage
            title="Deployments"
            caption="The endpoint, model names and API keys for a minibrain."
        >
            {(slug) => <Deployment key={slug} slug={slug} />}
        </ScopedPage>
    );
}
