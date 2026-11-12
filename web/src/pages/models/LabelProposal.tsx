import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Button, useToast } from "obp-ui";
import { type LabelProposal, type ModelDetail, api, unwrap } from "~/api/client";
import { ErrorLine, errorMessage } from "~/components/Section";
import { evaluationsHref } from "~/lib/modelLinks";
import { useContractChange } from "./JudgedSection";

const SHOWN = 3;

export function labelsLine(labels: string[]): string {
    const more = labels.length > SHOWN ? ` (+${labels.length - SHOWN})` : "";
    return `${labels.slice(0, SHOWN).join(", ")}${more}`;
}

function sourceOf(detail: ModelDetail, proposal: LabelProposal): string {
    const version = proposal.dataset_version_number ? ` v${proposal.dataset_version_number}` : "";
    const rows = detail.dataset_version?.rows;
    const name = `${detail.dataset_name ?? detail.dataset ?? "its data"}${version}`;
    return rows ? `The ${rows.toLocaleString()} rows of ${name}` : `The rows of ${name}`;
}

export function LabelProposalNotice({ detail }: { detail: ModelDetail }) {
    const client = useQueryClient();
    const toast = useToast();
    const router = useRouter();
    const proposal = detail.label_proposal;
    const slug = detail.slug;
    const scored = Object.keys(detail.dataset_version?.counts ?? {}).length > 0;
    const scoreVersion = async (): Promise<{ number?: number; problem?: string }> => {
        if (!scored) {
            return {};
        }
        try {
            const version = await unwrap(
                api.POST("/api/models/{name}/versions", {
                    params: { path: { name: slug } },
                    body: { kind: "prompt" },
                }),
            );
            return { number: version.number };
        } catch (error) {
            return { problem: errorMessage(error) };
        }
    };
    const changer = useContractChange(detail, async () => {
        const made = await scoreVersion();
        await client.invalidateQueries();
        toast({
            title: `Answers restricted to ${proposal?.labels.length ?? 0} labels`,
            description:
                made.number === undefined
                    ? `${detail.name} is a classifier now. ${made.problem ?? "The next version answers with one label."}`
                    : `${detail.name} is a classifier now; v${made.number} with the labels is being scored.`,
            tone: "success",
            action:
                made.number === undefined
                    ? undefined
                    : {
                          label: "Review results",
                          onClick: () => router.history.push(evaluationsHref(slug)),
                      },
        });
    });
    const dismiss = useMutation({
        mutationFn: (datasetVersionId: number) =>
            unwrap(
                api.PUT("/api/models/{name}/label-proposal/dismissal", {
                    params: { path: { name: slug } },
                    body: { dataset_version_id: datasetVersionId },
                }),
            ),
        onSuccess: () => client.invalidateQueries(),
    });
    if (!proposal) {
        return null;
    }
    const busy = changer.pending || dismiss.isPending;
    return (
        <section
            aria-label="Label proposal"
            className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-info-soft p-3"
        >
            <div className="flex min-w-0 max-w-3xl flex-col gap-1">
                <p className="font-semibold">
                    {`Answers look like labels: ${labelsLine(proposal.labels)}. Restrict answers to these?`}
                </p>
                <p>
                    {`${sourceOf(detail, proposal)} share ${proposal.labels.length} answers. Restricting makes this model a classifier: it answers with one of them, scored by accuracy and per label.`}
                </p>
                <ErrorLine error={changer.error ?? dismiss.error} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    disabled={busy}
                    onClick={() => changer.change({ kind: "json", labels: proposal.labels })}
                >
                    Restrict answers
                </Button>
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => dismiss.mutate(proposal.dataset_version_id)}
                >
                    Keep free text
                </Button>
            </div>
            {changer.confirm}
        </section>
    );
}
