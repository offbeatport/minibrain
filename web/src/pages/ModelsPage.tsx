import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useCan } from "~/lib/access";
import { useModelsSearch } from "~/lib/modelsSearch";
import { Discover } from "./models/Discover";
import { MyModels } from "./models/MyModels";

export function ModelsPage() {
    const router = useRouter();
    const { search, update } = useModelsSearch("/models");
    const add = () => router.history.push("/models/new");
    const can = useCan();
    return (
        <Page wide>
            <PageHeader
                title="Models"
                caption="Models added to this installation."
                actions={
                    can.build && (
                        <Button onClick={add}>
                            <Plus />
                            Add model
                        </Button>
                    )
                }
            />
            <MyModels search={search} update={update} />
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
