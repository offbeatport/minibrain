import { useMutation } from "@tanstack/react-query";
import { Info, Pencil, SlidersHorizontal } from "lucide-react";
import {
    Button,
    Input,
    Label,
    Link,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    type BaseModelDetail,
    type ModelDetail,
    type ModelRow,
    type VersionInfo,
    api,
    unwrap,
} from "~/api/client";
import { useFeedbackSummary, useTestExamples } from "~/api/feedbackQueries";
import { useModelTraffic } from "~/api/modelPageQueries";
import { useAllModels, useModelPage, usePresets, useVersionFiles } from "~/api/queries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { TAGS_HINT, editableTags, isSystemTag } from "~/components/Tags";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";
import { modelCardHref, modelPageHref, modelVersionHref, trainHref } from "~/lib/modelLinks";
import { bytes, relativeTime } from "~/lib/time";
import { splitTags, useModelsRefresh } from "../dialogs";
import { Clipped, Fact, Group, Mono, Muted, Row, parametersText } from "./facts";
import { baseNameOf, isDeployed } from "./header";
import { liveOf, versionLabel } from "./makeLive";
import { settingsHref } from "./settings";
import { useTrafficRange } from "./usage";

type EditKind = "description" | "tags";

const EDIT_TITLES: Record<EditKind, string> = { description: "Description", tags: "Tags" };

function EditForm({
    row,
    kind,
    onDone,
}: {
    row: ModelRow;
    kind: EditKind;
    onDone: () => void;
}) {
    const refresh = useModelsRefresh();
    const [text, setText] = useState(
        kind === "tags" ? editableTags(row.tags) : (row.description ?? ""),
    );
    const save = useMutation({
        mutationFn: async (): Promise<unknown> => {
            const body = kind === "tags" ? { tags: splitTags(text) } : { description: text.trim() };
            return unwrap(
                api.PATCH("/api/models/{name}", { params: { path: { name: row.key } }, body }),
            );
        },
        onSuccess: async () => {
            await refresh();
            onDone();
        },
    });
    const id = `edit-${kind}`;
    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
            }}
        >
            <div className="flex flex-col gap-label">
                <Label htmlFor={id}>{EDIT_TITLES[kind]}</Label>
                <Input
                    id={id}
                    autoFocus
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                />
                {kind === "tags" && <p className="text-sm text-muted-foreground">{TAGS_HINT}</p>}
            </div>
            <ErrorLine error={save.error} />
            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={save.isPending}>
                    Save
                </Button>
            </div>
        </form>
    );
}

const PENCIL =
    "text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:text-foreground data-popup-open:opacity-100 [@media(hover:none)]:opacity-100";

function EditPencil({ row, kind }: { row: ModelRow; kind: EditKind }) {
    const [open, setOpen] = useState(false);
    const label = `Edit ${EDIT_TITLES[kind].toLowerCase()}`;
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={label}
                            className={PENCIL}
                        >
                            <Pencil />
                        </Button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-80">
                {open && <EditForm row={row} kind={kind} onDone={() => setOpen(false)} />}
            </PopoverContent>
        </Popover>
    );
}

function EditLink({ href, label }: { href: string; label: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label}
                    className={PENCIL}
                    asChild
                >
                    <Link href={href}>
                        <Pencil />
                    </Link>
                </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

function useEdit(row: ModelRow) {
    const can = useCan();
    const allowed = row.kind === "base" ? can.admin : can.build;
    return (kind: EditKind) => (allowed ? <EditPencil row={row} kind={kind} /> : undefined);
}

function AboutSection({ children }: { children: ReactNode }) {
    return (
        <PanelSection icon={Info} title="About">
            <div className="@container">
                <dl className="grid gap-x-4 gap-y-3 @md:grid-cols-2 @xl:grid-cols-3">{children}</dl>
            </div>
        </PanelSection>
    );
}

function DetailsSection({ children }: { children: ReactNode }) {
    return (
        <PanelSection icon={SlidersHorizontal} title="Details" flush>
            <div className="@container flex flex-col divide-y py-1">{children}</div>
        </PanelSection>
    );
}

function userTags(row: ModelRow): string[] {
    return row.tags.filter((tag) => !isSystemTag(tag));
}

function plural(value: number, noun: string): string {
    return `${count(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function taskText(detail: ModelDetail | undefined, presetLabel: string | undefined): string {
    const contract = detail?.contract;
    const labels = contract?.labels ?? [];
    const fields = Object.keys(
        (contract?.json_schema?.properties as Record<string, unknown> | undefined) ?? {},
    );
    if (contract?.kind === "json" && fields.length > 0) {
        return `JSON · ${plural(fields.length, "field")}`;
    }
    if (labels.length > 0) {
        return `${presetLabel ?? "Labels"} · ${plural(labels.length, "label")}`;
    }
    return presetLabel ?? "Chat";
}

function scoreText(version: VersionInfo): string {
    return version.score === null
        ? versionLabel(version)
        : `${versionLabel(version)} · ${percent(version.score)} ${metricName(version.main_metric).toLowerCase()}`;
}

function createdText(page: ReturnType<typeof useModelPage>["data"]): string {
    const when = page?.created_at ? relativeTime(page.created_at) : null;
    return [page?.created_by, when].filter(Boolean).join(" · ") || "Unknown";
}

function datasetHref(slug: string): string {
    return `/data?item=${encodeURIComponent(`dataset:${slug}`)}`;
}

export function About({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const edit = useEdit(row);
    const models = useAllModels();
    const presets = usePresets();
    const page = useModelPage(row.key);
    const [range] = useTrafficRange();
    const traffic = useModelTraffic(row.key, range);
    const preset = presets.data?.presets.find((item) => item.key === detail?.preset);
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    const data = detail?.dataset_version;
    const replicas = traffic.data?.replicas.length ?? 0;
    const tags = userTags(row);
    return (
        <AboutSection>
            <Fact label="Task">
                <Clipped text={taskText(detail, preset?.label)} href={settingsHref(row.key)} />
            </Fact>
            <Fact label="Live">
                {live ? (
                    <Clipped text={scoreText(live)} href={modelVersionHref(row.key, live.number)} />
                ) : (
                    <Muted>Not deployed</Muted>
                )}
            </Fact>
            <Fact label="Base">
                <Clipped
                    text={baseNameOf(models.data, row.base_model)}
                    href={modelPageHref(row.base_model ?? "")}
                />
            </Fact>
            <Fact label="Data">
                {data && detail?.dataset ? (
                    <Clipped
                        text={`${detail.dataset_name ?? detail.dataset} v${data.number ?? "–"} · ${count(data.rows)} rows`}
                        href={datasetHref(detail.dataset)}
                    />
                ) : (
                    <Clipped text="Add data" href={trainHref(row.key)} />
                )}
            </Fact>
            <Fact label="Deployed">
                {isDeployed(row) ? (
                    <Clipped
                        text={`${replicas} ${replicas === 1 ? "replica" : "replicas"}`}
                        href={modelPageHref(row.key, "monitoring")}
                    />
                ) : (
                    <Muted>Not deployed</Muted>
                )}
            </Fact>
            <Fact label="API name">
                <Mono value={row.key} label="Copy API name" />
            </Fact>
            <Fact label="Tags" edit={edit("tags")}>
                {tags.length > 0 ? <Clipped text={tags.join(", ")} /> : <Muted>None</Muted>}
            </Fact>
            <Fact label="Created">
                <Clipped text={createdText(page.data)} />
            </Fact>
            <Fact label="Updated">
                <Clipped text={relativeTime(row.updated_at)} />
            </Fact>
            <Fact label="Description" edit={edit("description")} wide>
                {row.description ? <Clipped text={row.description} /> : <Muted>None</Muted>}
            </Fact>
        </AboutSection>
    );
}

function rulesText(detail: ModelDetail): string {
    const thresholds = detail.promotion.thresholds ?? [];
    const parts = thresholds.map(
        (item) =>
            `${metricName(item.metric)} ${item.op} ${item.value <= 1 ? percent(item.value) : item.value}`,
    );
    if (detail.promotion.beats_live) {
        parts.push("beats live");
    }
    return parts.length > 0 ? parts.join(", ") : "None";
}

function gradersText(detail: ModelDetail): string {
    const names = detail.graders.map((grader) => grader.name);
    return names.length > 0 ? [...new Set(names)].join(", ") : "Default for the task";
}

function splitsText(detail: ModelDetail): string | null {
    const counts = detail.dataset_version?.counts;
    if (!counts) {
        return null;
    }
    return `${count(counts.train ?? 0)} train · ${count(counts.eval ?? 0)} held out · ${count(counts.golden ?? 0)} test`;
}

function safetyText(detail: ModelDetail): string | null {
    const safety = detail.safety;
    if (!safety.effective) {
        return null;
    }
    const name = safety.effective_name ?? safety.effective;
    return `${name}${safety.effective_answers ? ", requests and answers" : ", requests"}${safety.source === "install" ? " · from Settings" : ""}`;
}

export function Details({
    row,
    detail,
    versions,
    base,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
    base: BaseModelDetail | undefined;
}) {
    const can = useCan();
    const [range] = useTrafficRange();
    const traffic = useModelTraffic(row.key, range);
    const summary = useFeedbackSummary(row.key);
    const examples = useTestExamples(can.build ? row.key : "");
    const live = liveOf(versions);
    const adapter = useVersionFiles(row.key, live?.kind === "lora" ? live.number : null);
    if (!detail) {
        return null;
    }
    const hosts = [...new Set((traffic.data?.replicas ?? []).map((item) => item.host))];
    const failed = versions.filter((version) => version.status === "failed").length;
    const copied = versions.find((version) => version.duplicated_from)?.duplicated_from;
    const switched =
        new Set(versions.map((version) => version.base_model).filter(Boolean)).size - 1;
    const labels = detail.contract.labels ?? [];
    const instructions = detail.instructions || detail.default_instructions;
    const firstLine = instructions.split("\n").find((line) => line.trim()) ?? "";
    const versionsHref = modelPageHref(row.key, "versions");
    const editLink = (href: string, label: string) =>
        can.build ? <EditLink href={href} label={label} /> : undefined;
    const splits = splitsText(detail);
    const safety = safetyText(detail);
    return (
        <DetailsSection>
            <Group title="Task setup">
                <Row label="Labels">
                    {labels.length > 0 ? (
                        <Clipped text={labels.join(", ")} className="font-mono text-sm" />
                    ) : (
                        <Muted>Free text</Muted>
                    )}
                </Row>
                <Row
                    label="Instructions"
                    edit={editLink(`${trainHref(row.key)}#instructions`, "Edit instructions")}
                >
                    {firstLine ? (
                        <Clipped
                            text={`${instructions.replace(/\n+/g, " ")}${detail.instructions ? "" : " (default)"}`}
                        />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Graders" edit={editLink(settingsHref(row.key), "Edit graders")}>
                    <Clipped text={gradersText(detail)} />
                </Row>
                <Row
                    label="Promotion rule"
                    edit={editLink(settingsHref(row.key), "Edit promotion rule")}
                >
                    <Clipped text={rulesText(detail)} />
                </Row>
            </Group>
            <Group title="Data">
                <Row label="Splits">
                    {splits ? <Clipped text={splits} /> : <Muted>No data yet</Muted>}
                </Row>
                <Row label="Feedback waiting">
                    <Clipped
                        text={`${count(summary.data?.pending ?? 0)} to review · ${count(summary.data?.accepted ?? 0)} accepted`}
                        href={`/feedback?model=${encodeURIComponent(row.key)}`}
                    />
                </Row>
                {can.build && (
                    <Row label="Test examples">
                        <Clipped
                            text={count(examples.data?.length ?? 0)}
                            href={`${modelPageHref(row.key, "settings")}#test-examples`}
                        />
                    </Row>
                )}
            </Group>
            <Group title="Serving">
                <Row label="Safety">{safety ? <Clipped text={safety} /> : <Muted>None</Muted>}</Row>
                <Row label="Inputs and answers">
                    <Clipped
                        text={detail.request_bodies.kept ? "Kept in request logs" : "Not kept"}
                        href={`${modelPageHref(row.key, "api")}#request-bodies`}
                    />
                </Row>
                <Row label="Machines">
                    {hosts.length > 0 ? (
                        <Clipped text={hosts.join(", ")} className="font-mono text-sm" />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
            </Group>
            <Group title="Lineage">
                <Row label="Created from">
                    {copied ? (
                        <Clipped
                            text={`Copy of ${copied.name} v${copied.number}`}
                            href={modelPageHref(copied.slug)}
                        />
                    ) : (
                        <Clipped text="New" />
                    )}
                </Row>
                <Row label="Base switches">
                    <Clipped text={switched > 0 ? count(switched) : "None"} />
                </Row>
                <Row label="Versions">
                    <Clipped
                        text={`${count(versions.length)}${failed > 0 ? ` · ${failed} failed` : ""}`}
                        href={versionsHref}
                    />
                </Row>
            </Group>
            <Group title="Integrity" caption="SHA-256, checked each time the weights load.">
                <Row label="Live adapter">
                    {adapter.data?.artifact_id ? (
                        <Mono value={adapter.data.artifact_id} label="Copy live adapter SHA-256" />
                    ) : (
                        <Muted>{live ? "Prompt only, no adapter" : "None"}</Muted>
                    )}
                </Row>
                <Row label="Base weights">
                    {base?.content_hash ? (
                        <Mono value={base.content_hash} label="Copy base SHA-256" />
                    ) : (
                        <Muted>Not recorded</Muted>
                    )}
                </Row>
                <Row label="Model card">
                    {live ? (
                        <Clipped
                            text={`v${live.number} card`}
                            href={modelCardHref(row.key, live.number)}
                        />
                    ) : (
                        <Muted>After a version is live</Muted>
                    )}
                </Row>
            </Group>
        </DetailsSection>
    );
}

export function BaseAbout({ row, base }: { row: ModelRow; base: BaseModelDetail | undefined }) {
    const edit = useEdit(row);
    const [range] = useTrafficRange();
    const traffic = useModelTraffic(row.key, range);
    const page = useModelPage(row.key);
    const replicas = traffic.data?.replicas.length ?? 0;
    const size = [
        base?.parameters ? `${parametersText(base.parameters)} parameters` : null,
        base?.context_tokens ? `${count(base.context_tokens)}-token context` : null,
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <AboutSection>
            <Fact label="Publisher">
                <Clipped text={base?.publisher ?? row.publisher ?? "–"} />
            </Fact>
            <Fact label="Size">
                <Clipped text={size || "–"} />
            </Fact>
            <Fact label="Licence">
                {base?.license_url ? (
                    <Clipped text={base.license_name ?? "Licence"} href={base.license_url} />
                ) : (
                    <Clipped text={base?.license_name ?? base?.license ?? "–"} />
                )}
            </Fact>
            <Fact label="Deployed">
                {isDeployed(row) ? (
                    <Clipped
                        text={`${replicas} ${replicas === 1 ? "replica" : "replicas"}`}
                        href={modelPageHref(row.key, "monitoring")}
                    />
                ) : (
                    <Muted>Not deployed</Muted>
                )}
            </Fact>
            <Fact label="Memory to serve">
                <Clipped text={base?.needed_bytes ? bytes(base.needed_bytes) : "–"} />
            </Fact>
            <Fact label="API name">
                <Mono value={row.key} label="Copy API name" />
            </Fact>
            <Fact label="Tags" edit={edit("tags")}>
                {userTags(row).length > 0 ? (
                    <Clipped text={userTags(row).join(", ")} />
                ) : (
                    <Muted>None</Muted>
                )}
            </Fact>
            <Fact label="Added">
                <Clipped text={createdText(page.data)} />
            </Fact>
            <Fact label="Last used">
                <Clipped text={base?.last_used_at ? relativeTime(base.last_used_at) : "Never"} />
            </Fact>
            <Fact label="Description" edit={edit("description")} wide>
                {row.description ? <Clipped text={row.description} /> : <Muted>None</Muted>}
            </Fact>
        </AboutSection>
    );
}

function sourceText(base: BaseModelDetail): string {
    if (base.source === "download") {
        return base.repo ? `${base.repo}@${(base.revision ?? "").slice(0, 12)}` : "Catalogue";
    }
    return `Imported from ${base.source_path?.replace(/^\w+:/, "") ?? "a folder"}`;
}

export function BaseDetails({ row, base }: { row: ModelRow; base: BaseModelDetail | undefined }) {
    const models = useAllModels();
    const [range] = useTrafficRange();
    const traffic = useModelTraffic(row.key, range);
    if (!base) {
        return null;
    }
    const hosts = [...new Set((traffic.data?.replicas ?? []).map((item) => item.host))];
    const children = (models.data ?? []).filter(
        (item) => item.kind === "custom" && item.base_model === row.key,
    );
    const serveOnly = base.serve_only ?? row.serve_only;
    return (
        <DetailsSection>
            <Group title="Serving">
                <Row label="Machines">
                    {hosts.length > 0 ? (
                        <Clipped text={hosts.join(", ")} className="font-mono text-sm" />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Training">
                    <Clipped text={serveOnly ? `Serve-only: ${serveOnly.reason}` : "LoRA, QLoRA"} />
                </Row>
                <Row label="Updates">
                    {base.update_available ? (
                        <Clipped
                            text={`Newer revision ${(base.latest_revision ?? "").slice(0, 12)} published; this pin stays until you choose`}
                        />
                    ) : (
                        <Muted>Pinned revision is current</Muted>
                    )}
                </Row>
            </Group>
            <Group title="Source">
                <Row label="From">
                    <Clipped text={sourceText(base)} className="font-mono text-sm" />
                </Row>
                <Row label="Stored in">
                    <Clipped text={base.store_label ?? base.storage_path} />
                </Row>
            </Group>
            {children.length > 0 && (
                <Group title="Lineage">
                    <Row label="Built on it">
                        <Clipped text={children.map((child) => child.name).join(", ")} />
                    </Row>
                </Group>
            )}
            <Group title="Integrity" caption="SHA-256, checked each time the weights load.">
                <Row label="Weights">
                    {base.content_hash ? (
                        <Mono value={base.content_hash} label="Copy weights SHA-256" />
                    ) : (
                        <Muted>Not recorded</Muted>
                    )}
                </Row>
                <Row label="Files">
                    <Clipped
                        text={`${count(base.files.length)} files · ${bytes(base.size_bytes)} · ${base.verified_at ? `verified ${relativeTime(base.verified_at)}` : "not verified yet"}`}
                        href={modelPageHref(row.key, "files")}
                    />
                </Row>
            </Group>
        </DetailsSection>
    );
}
