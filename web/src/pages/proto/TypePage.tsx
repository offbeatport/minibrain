import { Badge, Button, Input, TYPE_PAIRINGS, type TypePairing } from "obp-ui";
import type { CSSProperties } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const SHOWN = ["mona", "grotesk", "instrument", "plex", "geist"];

const CURRENT = "mona";

const ROWS = [
    { name: "Support triage", version: "v4", score: "91.2%", requests: "12,480", id: "ft-7c1e92" },
    { name: "Refund intents", version: "v2", score: "88.7%", requests: "3,014", id: "ft-03ab5d" },
    { name: "Ticket router", version: "v11", score: "94.0%", requests: "108,226", id: "ft-e94f10" },
];

function fonts(pairing: TypePairing): CSSProperties {
    return {
        "--font-sans": pairing.sans,
        "--font-display": pairing.display,
        "--font-mono": pairing.mono,
        fontFamily: pairing.sans,
    } as CSSProperties;
}

function Sample({ pairing }: { pairing: TypePairing }) {
    return (
        <div
            style={fonts(pairing)}
            className="flex flex-col gap-5 rounded-xl border bg-card p-panel"
        >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="flex items-center gap-2">
                    <span className="text-base font-semibold">{pairing.name}</span>
                    {pairing.id === CURRENT && <Badge variant="info">Cobalt now</Badge>}
                </span>
                <span className="font-mono text-sm text-muted-foreground">
                    {pairing.sans.split(",")[0].replaceAll('"', "")}
                    {" · "}
                    {pairing.mono.split(",")[0].replaceAll('"', "")}
                </span>
            </div>
            <div className="flex flex-col gap-1">
                <h2 className="text-3xl font-normal">Add model</h2>
                <p className="text-sm text-muted-foreground">
                    Pick a base model and name it. Train it on your data later, from its page.
                </p>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
                <div className="flex flex-col gap-label">
                    <label htmlFor={`name-${pairing.id}`} className="text-sm font-medium">
                        Name
                    </label>
                    <Input id={`name-${pairing.id}`} defaultValue="Qwen3 1.7B" />
                    <p className="text-sm text-muted-foreground">
                        Every request is logged with its latency, tokens and status.
                    </p>
                </div>
                <div className="flex flex-col gap-2 text-base">
                    <p>
                        Models trained on your own data hold their format and labels better than a
                        prompt, at a fraction of the cost. Base 54% → minibrain 91%.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm">Add model</Button>
                        <Button size="sm" variant="outline">
                            Cancel
                        </Button>
                        <Badge variant="success">Live</Badge>
                        <Badge variant="warning">Tight fit</Badge>
                    </div>
                </div>
            </div>
            <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                    <thead className="bg-secondary text-left text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Model</th>
                            <th className="px-3 py-2 font-medium">Version</th>
                            <th className="px-3 py-2 text-right font-medium">Held-out</th>
                            <th className="px-3 py-2 text-right font-medium">Requests, 7 days</th>
                            <th className="px-3 py-2 font-medium">Job</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y">
                        {ROWS.map((row) => (
                            <tr key={row.id}>
                                <td className="px-3 py-2 font-medium">{row.name}</td>
                                <td className="px-3 py-2">{row.version}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{row.score}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {row.requests}
                                </td>
                                <td className="px-3 py-2 font-mono">{row.id}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="text-sm text-muted-foreground">{pairing.note}</p>
        </div>
    );
}

export function TypePage() {
    const pairings = SHOWN.flatMap((id) => TYPE_PAIRINGS.filter((pairing) => pairing.id === id));
    return (
        <Page>
            <PageHeader
                title="Type"
                caption="The same slice of minibrain in each type pairing the kit ships. Prototype; not in the sidebar."
            />
            <Section
                title="Pairings"
                caption="Title, caption, form, body, buttons, badges, a table with numbers and IDs."
            >
                <div className="flex flex-col gap-5">
                    {pairings.map((pairing) => (
                        <Sample key={pairing.id} pairing={pairing} />
                    ))}
                </div>
            </Section>
        </Page>
    );
}
