import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type KeyCreated, type KeyInfo, api, succeed, unwrap } from "~/api/client";
import { keys, useKeys, useMinibrain } from "~/api/queries";
import { type Column, DataTable } from "~/components/DataTable";
import { CodeBlock, ErrorLine, Page, Section } from "~/components/Section";
import { dateTime } from "~/lib/format";
import { useSlug } from "./MinibrainLayout";

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
    const columns: Column<KeyInfo>[] = [
        { key: "name", header: "Name" },
        {
            key: "prefix",
            header: "Key",
            cell: (row) => <span className="font-mono">{row.prefix}…</span>,
        },
        { key: "created_at", header: "Created", cell: (row) => dateTime(row.created_at) },
        { key: "last_used_at", header: "Last used", cell: (row) => dateTime(row.last_used_at) },
        {
            key: "revoke",
            header: "",
            width: "120px",
            align: "right",
            cell: (row) => (
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(row.id)}>
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
            <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-3">
                <div className="w-64">
                    <Input
                        label="Name"
                        value={name}
                        onChange={setName}
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

export function EndpointPage() {
    const slug = useSlug();
    const { data: detail } = useMinibrain(slug);
    const [created, setCreated] = useState<KeyCreated | null>(null);
    if (!detail) {
        return null;
    }
    const baseUrl = `${window.location.origin}/v1`;
    const model = detail.models[0] ?? slug;
    const code = snippets(baseUrl, model, created?.secret ?? "YOUR_KEY");
    return (
        <Page>
            <Section
                title="Endpoint"
                caption="OpenAI-compatible. Point any OpenAI client at this base URL."
            >
                <div className="flex flex-col gap-4 text-sm">
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
                        <p className="mt-1 text-muted-foreground">
                            <span className="font-mono">{slug}</span> follows the current version;{" "}
                            <span className="font-mono">{slug}@N</span> pins one.
                        </p>
                    </div>
                </div>
            </Section>
            <KeysSection slug={slug} onCreated={setCreated} />
            {created && (
                <div className="rounded-2xl border border-success/40 bg-success/10 p-5 text-sm">
                    <div className="font-medium">New key for {created.name}</div>
                    <div className="mt-1 break-all font-mono">{created.secret}</div>
                    <p className="mt-1 text-muted-foreground">
                        Copy it now; it is not shown again.
                    </p>
                </div>
            )}
            <Section title="Examples">
                <div className="flex flex-col gap-3">
                    <CodeBlock>{code.curl}</CodeBlock>
                    <CodeBlock>{code.python}</CodeBlock>
                </div>
            </Section>
        </Page>
    );
}
