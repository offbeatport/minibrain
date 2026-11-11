import { useRouter } from "@tanstack/react-router";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useModelsSearch } from "~/lib/modelsSearch";
import { Discover } from "./models/Discover";
import { ModelsList } from "./models/list/ModelsList";

export function ModelsPage() {
    return (
        <Page wide>
            <PageHeader title="Models" caption="Models available on this install." />
            <ModelsList />
        </Page>
    );
}

export function DiscoverPage() {
    const router = useRouter();
    const { search, update } = useModelsSearch("/discover");
    return (
        <Page wide>
            <PageHeader
                title="Discover"
                caption="Find supported models to download and run privately."
            />
            <Discover
                search={search}
                update={update}
                onImport={() => router.history.push("/models/new?source=import")}
            />
        </Page>
    );
}
