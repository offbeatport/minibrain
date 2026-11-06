import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import {
    Button,
    Card,
    CardContent,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Link,
    Textarea,
} from "obp-ui";
import { useState } from "react";
import { api, unwrap } from "~/api/client";
import { useModel, useVersions } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSections, Stat } from "~/components/Section";
import { VersionState } from "~/components/StatusBadge";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { modelAibomHref, modelCardDownloadHref, modelPageHref } from "~/lib/modelLinks";
import {
    ApprovalsSection,
    BaseSection,
    DataSection,
    EvaluationSection,
    IntegritySection,
    KIND_NAMES,
    LimitsSection,
    type ModelCard,
    PurposeSection,
    TrainingSection,
    UseSection,
} from "./ModelCardSections";
import { Updated } from "./MyModels";

const BUSY = new Set(["training", "evaluating"]);

type Target = { slug: string; number: number };

function cardKey(target: Target) {
    return ["model", target.slug, "card", target.number] as const;
}

function cardPath(target: Target) {
    return { params: { path: target } };
}

function useModelCard(target: Target) {
    return useQuery({
        queryKey: cardKey(target),
        queryFn: () =>
            unwrap(api.GET("/api/models/{slug}/versions/{number}/card", cardPath(target))),
        refetchInterval: (query) =>
            BUSY.has(query.state.data?.card.version.status ?? "") ? 2000 : false,
    });
}

function BackLink({ slug, name }: { slug: string; name: string }) {
    return (
        <Link
            href={modelPageHref(slug, "versions")}
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
            <ChevronLeft className="size-4" />
            {name}
        </Link>
    );
}

function Change({ value }: { value: number | null | undefined }) {
    if (value === null || value === undefined) {
        return <span className="text-muted-foreground">–</span>;
    }
    const points = (Math.abs(value) * 100).toFixed(1);
    if (points === "0.0") {
        return <span className="text-muted-foreground">Same</span>;
    }
    return value > 0 ? (
        <span className="text-success">{`+${points} pts`}</span>
    ) : (
        <span className="text-destructive">{`−${points} pts`}</span>
    );
}

function Summary({ card, live }: { card: ModelCard; live: boolean }) {
    const version = card.version;
    const baseline = card.evaluation.prompt_only;
    return (
        <Card>
            <CardContent className="flex flex-wrap gap-x-8 gap-y-4">
                <Stat label="Kind" value={KIND_NAMES[version.kind] ?? version.kind} />
                <Stat
                    label="Status"
                    value={<VersionState version={{ status: version.status, live }} />}
                />
                <Stat
                    label="Held-out accuracy"
                    value={percent(card.evaluation.held_out?.accuracy)}
                />
                <Stat
                    label={baseline ? `vs prompt-only v${baseline.number}` : "vs prompt-only"}
                    value={<Change value={baseline?.accuracy_change} />}
                />
                <Stat label="Created" value={<Updated value={version.created_at} />} />
                <Stat label="Owner" value={card.use.owner} />
            </CardContent>
        </Card>
    );
}

type Draft = { intended_use: string; known_limits: string };

type Focus = keyof Draft;

function EditDialog({
    target,
    card,
    focus,
    onOpenChange,
}: {
    target: Target;
    card: ModelCard;
    focus: Focus;
    onOpenChange: (open: boolean) => void;
}) {
    const client = useQueryClient();
    const [draft, setDraft] = useState<Draft>({
        intended_use: card.use.intended_use,
        known_limits: card.limits.known_limits,
    });
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PUT("/api/models/{slug}/versions/{number}/card", {
                    ...cardPath(target),
                    body: draft,
                }),
            ),
        onSuccess: (data) => {
            client.setQueryData(cardKey(target), data);
            onOpenChange(false);
        },
    });
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        save.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{`Edit the card for v${card.version.number}`}</DialogTitle>
                        <DialogDescription>
                            Stored with this version only. Each change is written to the audit log
                            and changes the card's digest.
                        </DialogDescription>
                    </DialogHeader>
                    <Field
                        id="card-use"
                        label="Intended use"
                        hint="Who should use it, for what, and what it must not be used for."
                    >
                        <Textarea
                            id="card-use"
                            autoFocus={focus === "intended_use"}
                            rows={3}
                            maxLength={2000}
                            value={draft.intended_use}
                            onChange={(event) =>
                                setDraft({ ...draft, intended_use: event.target.value })
                            }
                        />
                    </Field>
                    <Field
                        id="card-limits"
                        label="Known limits"
                        hint="What reviewers found that the scores do not show."
                    >
                        <Textarea
                            id="card-limits"
                            autoFocus={focus === "known_limits"}
                            rows={5}
                            maxLength={10000}
                            value={draft.known_limits}
                            onChange={(event) =>
                                setDraft({ ...draft, known_limits: event.target.value })
                            }
                        />
                    </Field>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={save.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Downloads({ target }: { target: Target }) {
    return (
        <>
            <Button variant="outline" asChild>
                <a href={modelCardDownloadHref(target.slug, target.number, "md")} download>
                    Download Markdown
                </a>
            </Button>
            <Button variant="outline" asChild>
                <a href={modelCardDownloadHref(target.slug, target.number, "json")} download>
                    Download JSON
                </a>
            </Button>
            <Button variant="outline" asChild>
                <a href={modelAibomHref(target.slug, target.number)} download>
                    Download AI-BOM
                </a>
            </Button>
        </>
    );
}

function CardView({
    target,
    card,
    sha256,
    form,
}: {
    target: Target;
    card: ModelCard;
    sha256: string;
    form: string | undefined;
}) {
    const [editing, setEditing] = useState<Focus | null>(null);
    const can = useCan();
    const versions = useVersions(target.slug);
    const model = useModel(target.slug);
    const current = versions.data?.find((item) => item.number === target.number)?.current ?? false;
    const live = current && Boolean(model.data?.deployed);
    return (
        <>
            <BackLink slug={target.slug} name={card.version.name} />
            <PageHeader
                title={`${card.version.name} v${card.version.number}`}
                icon={<PublisherLogo name={card.version.name} size="lg" />}
                caption="Model card and validation report, built from the stored version, its data, its scores and the audit log."
                actions={<Downloads target={target} />}
            />
            <Summary card={card} live={live} />
            <PanelSections>
                <PurposeSection card={card} />
                <UseSection
                    card={card}
                    onEdit={can.build ? () => setEditing("intended_use") : undefined}
                />
                <BaseSection card={card} />
                <DataSection card={card} />
                <TrainingSection card={card} />
                <EvaluationSection card={card} />
                <LimitsSection
                    card={card}
                    onEdit={can.build ? () => setEditing("known_limits") : undefined}
                />
                <ApprovalsSection card={card} />
                <IntegritySection sha256={sha256} form={form} />
            </PanelSections>
            {editing && (
                <EditDialog
                    target={target}
                    card={card}
                    focus={editing}
                    onOpenChange={(open) => !open && setEditing(null)}
                />
            )}
        </>
    );
}

export function ModelCardPage() {
    const params = useParams({ strict: false }) as { name?: string; number?: string };
    const target = { slug: params.name ?? "", number: Number(params.number) };
    const card = useModelCard(target);
    return (
        <Page>
            {card.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            <ErrorLine error={card.error} />
            {card.data && (
                <CardView
                    target={target}
                    card={card.data.card}
                    sha256={card.data.sha256}
                    form={card.data.canonical_form}
                />
            )}
        </Page>
    );
}
