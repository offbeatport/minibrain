import { useMutation } from "@tanstack/react-query";
import { Button, Input, Label } from "obp-ui";
import { useState } from "react";
import { api, unwrap } from "~/api/client";
import { isActiveJob, useJobs, useMinibrain } from "~/api/queries";
import { JobPanel } from "~/components/JobPanel";
import { ScopedPage } from "~/components/PageHeader";
import { ErrorLine, Section } from "~/components/Section";
import { useInvalidate } from "~/lib/jobs";

const FINISHED_SHOWN = 5;

function CreateVersion({ slug }: { slug: string }) {
    const invalidate = useInvalidate(slug);
    const [maxRows, setMaxRows] = useState("3000");
    const [epochs, setEpochs] = useState("1");
    const create = useMutation({
        mutationFn: (body: { kind: "prompt" | "lora"; max_rows?: number; epochs?: number }) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions", { params: { path: { slug } }, body }),
            ),
        onSuccess: invalidate,
    });
    const train = () =>
        create.mutate({ kind: "lora", max_rows: Number(maxRows), epochs: Number(epochs) });
    return (
        <Section
            title="New version"
            caption="Score the base model with a prompt first. Train when the score shows a gap worth closing."
        >
            <div className="flex flex-wrap items-end gap-6">
                <Button variant="outline" onClick={() => create.mutate({ kind: "prompt" })}>
                    Score prompt-only version
                </Button>
                <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="max-rows">Training rows</Label>
                        <Input
                            id="max-rows"
                            className="w-28 tabular-nums"
                            inputMode="numeric"
                            value={maxRows}
                            onChange={(event) => setMaxRows(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="epochs">Epochs</Label>
                        <Input
                            id="epochs"
                            className="w-20 tabular-nums"
                            inputMode="decimal"
                            value={epochs}
                            onChange={(event) => setEpochs(event.target.value)}
                        />
                    </div>
                    <Button onClick={train} disabled={create.isPending}>
                        Train new version
                    </Button>
                </div>
            </div>
            <ErrorLine error={create.error} />
        </Section>
    );
}

function Training({ slug }: { slug: string }) {
    const { data: detail } = useMinibrain(slug);
    const { data: jobs } = useJobs(slug);
    if (!detail) {
        return null;
    }
    if (!detail.snapshot) {
        return (
            <p className="text-sm text-muted-foreground">
                Build the dataset on the Data page first.
            </p>
        );
    }
    const active = (jobs ?? []).filter(isActiveJob);
    const finished = (jobs ?? []).filter((job) => !isActiveJob(job)).slice(0, FINISHED_SHOWN);
    return (
        <>
            <CreateVersion slug={slug} />
            <Section title="Jobs" caption="One job runs at a time; the rest wait in the queue.">
                {active.length + finished.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No jobs yet.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {[...active, ...finished].map((job) => (
                            <JobPanel key={job.id} job={job} slug={slug} />
                        ))}
                    </div>
                )}
            </Section>
        </>
    );
}

export function TrainingPage() {
    return (
        <ScopedPage title="Training" caption="Score prompt-only versions and train new ones.">
            {(slug) => <Training slug={slug} />}
        </ScopedPage>
    );
}
