import { BookOpen, Plug } from "lucide-react";
import {
    Button,
    CodeBlock,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
} from "obp-ui";
import type { ReactNode } from "react";
import type { ModelRow } from "~/api/client";
import { useModel } from "~/api/queries";
import { CopyButton } from "~/components/CopyButton";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { feedbackForModel } from "~/lib/feedback";
import { API_REFERENCE_PATH, modelPageHref } from "~/lib/modelLinks";
import { isDeployed } from "./header";

function feedbackCurl(baseUrl: string, model: string, key: string, kept: boolean): string {
    const body = {
        model,
        response_id: "chatcmpl-abc123",
        rating: "down",
        correction: "billing",
        ...(kept ? {} : { input: "I was charged twice" }),
    };
    return [
        `curl ${baseUrl}/feedback \\`,
        `  -H "Authorization: Bearer ${key}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify(body, null, 4).replaceAll("\n", "\n  ")}'`,
    ].join("\n");
}

function Copyable({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="flex h-8 min-w-0 items-center gap-1 rounded-md border bg-muted pr-0.5 pl-3">
                <span className="flex-1 truncate font-mono text-sm">{value}</span>
                <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
            </span>
        </div>
    );
}

function Step({
    number,
    title,
    hint,
    children,
}: {
    number: number;
    title: string;
    hint?: ReactNode;
    children: ReactNode;
}) {
    return (
        <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-md border bg-background text-sm font-medium tabular-nums"
            >
                {number}
            </span>
            <div className="flex min-w-0 flex-col gap-3">
                <div className="flex min-h-7 flex-col justify-center gap-0.5">
                    <h3 className="font-medium">{title}</h3>
                    {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
                </div>
                {children}
            </div>
        </li>
    );
}

export function ConnectDialog({
    row,
    open,
    onOpenChange,
    keyValue = null,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    keyValue?: string | null;
}) {
    const baseUrl = `${window.location.origin}/v1`;
    const custom = row.kind === "custom";
    const pinned = custom ? (row.current_version ?? row.ready_version) : null;
    const detail = useModel(custom && open ? row.key : "");
    const kept = detail.data?.request_bodies.kept ?? false;
    const key = keyValue ?? "YOUR_KEY";
    const keysHref = modelPageHref(row.key, "api");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Plug aria-hidden="true" className="size-5 text-muted-foreground" />
                        {`Connect to ${row.name}`}
                    </DialogTitle>
                    <DialogDescription>
                        OpenAI-compatible, so any OpenAI client works.
                    </DialogDescription>
                </DialogHeader>
                {!isDeployed(row) && (
                    <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
                        {`${row.name} is not deployed yet, so calls are refused until you deploy it.`}
                    </p>
                )}
                <ol className="flex flex-col gap-8">
                    <Step
                        number={1}
                        title="Endpoint"
                        hint={
                            custom
                                ? `${row.key} answers with the deployed version; ${row.key}@N calls one version.`
                                : undefined
                        }
                    >
                        <div className="grid gap-4 sm:grid-cols-[3fr_2fr_2fr]">
                            <Copyable label="Base URL" value={baseUrl} />
                            <Copyable label="Model" value={row.key} />
                            {pinned !== null && pinned !== undefined && (
                                <Copyable label="One version" value={`${row.key}@${pinned}`} />
                            )}
                        </div>
                    </Step>
                    <Step
                        number={2}
                        title="API key"
                        hint={keyValue ? "Your new key. It is shown once; copy it now." : undefined}
                    >
                        {keyValue ? (
                            <Copyable label="Key" value={keyValue} />
                        ) : (
                            <p>
                                {"Use a key that covers this model; the examples say "}
                                <span className="font-mono">YOUR_KEY</span>
                                {". "}
                                <Link
                                    href={keysHref}
                                    onClick={() => onOpenChange(false)}
                                    className="text-primary hover:underline"
                                >
                                    Create one in API keys
                                </Link>
                            </p>
                        )}
                    </Step>
                    <Step number={3} title="Call it">
                        <HarnessConfigs
                            baseUrl={baseUrl}
                            model={row.key}
                            keyValue={keyValue}
                            hint={false}
                        />
                    </Step>
                    <Step
                        number={4}
                        title="Send feedback"
                        hint={
                            <>
                                {"Optional. Rate an answer by its "}
                                <span className="font-mono">id</span>
                                {kept
                                    ? " and give the right one. "
                                    : ", give the right one and send the user message as input. "}
                                {"Accepted corrections in "}
                                <Link
                                    href={feedbackForModel(row.key)}
                                    onClick={() => onOpenChange(false)}
                                    className="text-primary hover:underline"
                                >
                                    Feedback
                                </Link>
                                {" join the next training data."}
                            </>
                        }
                    >
                        <CodeBlock
                            code={feedbackCurl(baseUrl, row.key, key, kept)}
                            language="bash"
                            copyLabel="Copy the feedback call"
                        />
                    </Step>
                </ol>
                <DialogFooter className="sm:justify-between">
                    <Button variant="ghost" asChild>
                        <Link href={API_REFERENCE_PATH} onClick={() => onOpenChange(false)}>
                            <BookOpen aria-hidden="true" />
                            API reference
                        </Link>
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
