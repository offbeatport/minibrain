import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "obp-ui";
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useModelsSearch } from "~/lib/modelsSearch";
import { Discover } from "./models/Discover";
import { MyModels } from "./models/MyModels";
import { CreateModelDialog, ImportModelDialog } from "./models/dialogs";

function ImportButton({ onClick }: { onClick: () => void }) {
    return (
        <Button variant="outline" onClick={onClick}>
            Import model
        </Button>
    );
}

export function ModelsPage() {
    const router = useRouter();
    const { search, update } = useModelsSearch("/models");
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    return (
        <Page>
            <PageHeader
                title="Models"
                caption="Models added to this installation."
                actions={
                    <>
                        <ImportButton onClick={() => setImporting(true)} />
                        <Button onClick={() => setCreating(true)}>
                            <Plus />
                            Add model
                        </Button>
                    </>
                }
            />
            <MyModels
                search={search}
                update={update}
                onDiscover={() => router.history.push("/discover")}
                onCreate={() => setCreating(true)}
            />
            <CreateModelDialog open={creating} onOpenChange={setCreating} />
            <ImportModelDialog open={importing} onOpenChange={setImporting} />
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
                actions={<ImportButton onClick={() => setImporting(true)} />}
            />
            <Discover search={search} update={update} onImport={() => setImporting(true)} />
            <ImportModelDialog open={importing} onOpenChange={setImporting} />
        </Page>
    );
}
