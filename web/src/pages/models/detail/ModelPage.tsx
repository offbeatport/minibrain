import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ModelRow } from "~/api/client";
import { useAllModels, useBaseModel } from "~/api/queries";
import { ErrorLine, Page } from "~/components/Section";
import { modelPageHref } from "~/lib/modelLinks";
import { BaseModelView } from "./BaseModelView";
import { CustomModelView } from "./CustomModelView";
import { BackLink, useModelTab } from "./parts";

function BaseModelLoader({ row }: { row: ModelRow }) {
    const model = useBaseModel(row.key);
    const tab = useModelTab(row);
    return (
        <>
            <ErrorLine error={model.error} />
            {model.data && <BaseModelView model={model.data} tab={tab} />}
        </>
    );
}

function CustomModelLoader({ row }: { row: ModelRow }) {
    const tab = useModelTab(row);
    return <CustomModelView row={row} tab={tab} />;
}

export function ModelPage() {
    const { name } = useParams({ strict: false }) as { name?: string };
    const models = useAllModels();
    const row = models.data?.find((item) => item.key === name);
    return (
        <Page>
            <BackLink />
            {models.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            <ErrorLine error={models.error} />
            {models.data && !row && (
                <p className="text-sm text-muted-foreground">{`No model called ${name}.`}</p>
            )}
            {row?.kind === "base" && <BaseModelLoader key={row.key} row={row} />}
            {row?.kind === "custom" && <CustomModelLoader key={row.key} row={row} />}
        </Page>
    );
}

export function OldModelLink() {
    const params = useParams({ strict: false }) as { key?: string; slug?: string; number?: string };
    const router = useRouter();
    const name = params.key ?? params.slug ?? "";
    const target = params.number
        ? `${modelPageHref(name)}/versions/${params.number}/card`
        : modelPageHref(name);
    useEffect(() => {
        router.history.replace(target);
    }, [router, target]);
    return null;
}
