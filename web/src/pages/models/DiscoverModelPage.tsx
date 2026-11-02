import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, ExternalLink, Info, Layers, Scale } from "lucide-react";
import { Button, DataGrid, Link, Skeleton } from "obp-ui";
import { type ReactNode, useMemo, useState } from "react";
import type { CatalogEntry, CatalogResponse, CatalogVariantInfo } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { discoverListHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import {
    AccessSteps,
    type Actions,
    DownloadDialog,
    EntryAction,
    Fit,
    discoverHref,
    parameters,
    poolPhrase,
} from "./Discover";
import { useModelsRefresh } from "./dialogs";

const DOWNLOADS = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
});

function external(href: string, text: string) {
    return (
        <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            {text}
            <ExternalLink className="ml-0.5 inline size-3.5" />
        </a>
    );
}

function About({ entry, catalog }: { entry: CatalogEntry; catalog: CatalogResponse }) {
    const newer = entry.superseded_by
        ? catalog.entries.find((item) => item.id === entry.superseded_by)
        : undefined;
    return (
        <PanelSection icon={Info} title="About">
            <div className="flex flex-col gap-4">
                {entry.description && <p className="text-base">{entry.description}</p>}
                <Facts
                    items={[
                        ["Publisher", entry.provider],
                        ["Repository", external(`${catalog.endpoint}/${entry.repo}`, entry.repo)],
                        ["Parameters", `${parameters(entry)} · size ${entry.tier}`],
                        ["Architecture", `${entry.architecture} · generation ${entry.generation}`],
                        ["Tasks", entry.capabilities.join(", ")],
                        [
                            "Fine-tuning",
                            entry.trainable
                                ? "Can be used as a base for training"
                                : "Serving only for now",
                        ],
                        ["Downloads", `${DOWNLOADS.format(entry.popularity)} on Hugging Face`],
                        ...(entry.origin === "hub"
                            ? ([["Origin", "Added from Hugging Face"]] as [string, string][])
                            : []),
                        ...(entry.recommendation
                            ? ([["Why recommended", entry.recommendation]] as [string, string][])
                            : []),
                        ...(newer
                            ? ([
                                  [
                                      "Newer version",
                                      <Link
                                          key="newer"
                                          href={discoverHref(
                                              newer,
                                              catalog.pool === "local" ? undefined : catalog.pool,
                                          )}
                                      >
                                          {newer.name}
                                      </Link>,
                                  ],
                              ] as [string, ReactNode][])
                            : []),
                    ]}
                />
            </div>
        </PanelSection>
    );
}

function variantColumns(
    allowed: boolean,
    onDownload: (variant: CatalogVariantInfo) => void,
): ColumnDef<CatalogVariantInfo, unknown>[] {
    return [
        { id: "label", header: "Variant", accessorFn: (variant) => variant.label },
        {
            id: "size",
            header: "Download size",
            accessorFn: (variant) => variant.size_bytes,
            cell: ({ row }) => bytes(row.original.size_bytes),
        },
        {
            id: "memory",
            header: "Memory needed",
            accessorFn: (variant) => variant.fit.needed_bytes,
            cell: ({ row }) => bytes(row.original.fit.needed_bytes),
        },
        {
            id: "fit",
            header: "Fit",
            enableSorting: false,
            cell: ({ row }) => (
                <div className="flex max-w-96 flex-col whitespace-normal">
                    <Fit fit={row.original.fit} />
                    <span className="text-sm text-muted-foreground">{row.original.fit.basis}</span>
                </div>
            ),
        },
        {
            id: "runtimes",
            header: "Runs on",
            accessorFn: (variant) => variant.runtimes.join(", "),
        },
        {
            id: "action",
            header: () => <span className="sr-only">Action</span>,
            enableSorting: false,
            cell: ({ row }) => (
                <div className="flex justify-end">
                    <Button
                        size="xs"
                        variant="outline"
                        disabled={!allowed}
                        onClick={() => onDownload(row.original)}
                    >
                        Download
                    </Button>
                </div>
            ),
        },
    ];
}

function Licence({ entry }: { entry: CatalogEntry }) {
    return (
        <PanelSection icon={Scale} title="Licence">
            <div className="flex flex-col gap-2 text-sm">
                <span className="font-semibold">{entry.license_name}</span>
                <p className="text-muted-foreground">{entry.license_summary}</p>
                {entry.license_url && external(entry.license_url, "Read the licence")}
            </div>
        </PanelSection>
    );
}

export function DiscoverModelPage() {
    const { id } = useParams({ strict: false }) as { id?: string };
    const pool = useRouterState({
        select: (state) => (state.location.search as { pool?: string }).pool,
    });
    const router = useRouter();
    const refresh = useModelsRefresh();
    const catalog = useCatalog(pool);
    const [downloading, setDownloading] = useState<{ variant?: string } | null>(null);
    const data = catalog.data;
    const entry = data?.entries.find((item) => item.id === id);
    const on: Actions = useMemo(
        () => ({
            download: () => setDownloading({}),
            requirements: () => document.getElementById("access")?.scrollIntoView(),
            open: (path) => router.history.push(path),
            refresh,
            online: data?.online !== false,
            tokenConfigured: Boolean(data?.token_configured),
        }),
        [router, refresh, data?.online, data?.token_configured],
    );
    const blocked = !on.online || Boolean(entry?.gated && !on.tokenConfigured);
    const table = useMemo(
        () => variantColumns(!blocked, (variant) => setDownloading({ variant: variant.id })),
        [blocked],
    );
    return (
        <Page>
            <Link
                href={discoverListHref()}
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                Discover
            </Link>
            <ErrorLine error={catalog.error} />
            {catalog.isLoading && (
                <div className="flex flex-col gap-8 pt-2">
                    <div className="flex items-center gap-3">
                        <Skeleton className="size-8" />
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-6 w-56" />
                            <Skeleton className="h-4 w-72" />
                        </div>
                    </div>
                    <Skeleton className="h-48 w-full" />
                    <Skeleton className="h-32 w-full" />
                </div>
            )}
            {data && !entry && (
                <p className="text-sm text-muted-foreground">No model {id} in the catalogue.</p>
            )}
            {data && entry && (
                <>
                    <PageHeader
                        title={entry.name}
                        icon={<PublisherLogo publisher={entry.provider} name={entry.name} />}
                        caption={`${entry.provider} · ${parameters(entry)} · ${entry.license_name}`}
                        actions={<EntryAction entry={entry} on={on} />}
                    />
                    <PanelSections>
                        {entry.gated && (
                            <PanelSection icon={Info} title="Needs access from the publisher">
                                <div id="access" className="flex flex-col gap-2">
                                    <StatusText tone="warning">
                                        {data.token_configured
                                            ? "Accept the licence on the publisher's page if you have not yet."
                                            : "Downloads need a Hugging Face token with access."}
                                    </StatusText>
                                    <AccessSteps entry={entry} catalog={data} />
                                </div>
                            </PanelSection>
                        )}
                        <About entry={entry} catalog={data} />
                        <PanelSection
                            icon={Layers}
                            title="Variants"
                            description={`Fit is estimated for ${poolPhrase(data)} from the weights' size; real use also depends on context length and batch size.`}
                            bare
                        >
                            <DataGrid columns={table} rows={entry.variants} sortable={false} />
                        </PanelSection>
                        <Licence entry={entry} />
                    </PanelSections>
                    <DownloadDialog
                        entry={downloading ? entry : null}
                        preferred={downloading?.variant}
                        catalog={data}
                        onOpenChange={(open) => !open && setDownloading(null)}
                    />
                </>
            )}
        </Page>
    );
}
