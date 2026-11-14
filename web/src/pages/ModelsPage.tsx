import { useRouter } from "@tanstack/react-router";
import { Button, CubePlus, Link } from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useCan } from "~/lib/access";
import { useModelsSearch } from "~/lib/modelsSearch";
import { Discover } from "./models/Discover";
import { ModelsList } from "./models/list/ModelsList";

export function ModelsPage() {
    const can = useCan();
    return (
        <Page wide>
            <PageHeader
                title="Models"
                caption="Models available on this install."
                actions={
                    can.build && (
                        <Button asChild>
                            <Link href="/models/new">
                                <CubePlus />
                                Add model
                            </Link>
                        </Button>
                    )
                }
            />
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
