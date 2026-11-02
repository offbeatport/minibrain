import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "obp-ui";
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useModelsSearch } from "~/lib/modelsSearch";
import { AddModelDialog } from "./models/AddModelDialog";
import { Discover } from "./models/Discover";
import { MyModels } from "./models/MyModels";

export function ModelsPage() {
    const router = useRouter();
    const { search, update } = useModelsSearch("/models");
    const [creating, setCreating] = useState(false);
    return (
        <Page>
            <PageHeader
                title="Models"
                caption="Models added to this installation."
                actions={
                    <Button onClick={() => setCreating(true)}>
                        <Plus />
                        Add model
                    </Button>
                }
            />
            <MyModels
                search={search}
                update={update}
                onDiscover={() => router.history.push("/discover")}
                onCreate={() => setCreating(true)}
            />
            <AddModelDialog open={creating} onOpenChange={setCreating} />
        </Page>
    );
}

export function DiscoverPage() {
    const { search, update } = useModelsSearch("/discover");
    const [importing, setImporting] = useState(false);
    return (
        <Page>
            <PageHeader
                title="Discover"
                caption="Find supported models to download and run privately."
            />
            <Discover search={search} update={update} onImport={() => setImporting(true)} />
            <AddModelDialog open={importing} onOpenChange={setImporting} source="folder" />
        </Page>
    );
}
