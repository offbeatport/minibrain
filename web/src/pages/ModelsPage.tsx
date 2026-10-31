import { Button, Tabs, TabsList, TabsTrigger } from "obp-ui";
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useModelsSearch } from "~/lib/modelsSearch";
import { Discover } from "./models/Discover";
import { MyModels } from "./models/MyModels";
import { CreateModelDialog, ImportModelDialog } from "./models/dialogs";

const CAPTIONS = {
    mine: "Models added to this installation.",
    discover: "Find supported models to download and run privately.",
};

export function ModelsPage() {
    const { search, update } = useModelsSearch();
    const tab = search.tab === "discover" ? "discover" : "mine";
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    const switchTab = (next: string) =>
        update({ tab: next === "discover" ? "discover" : "", q: "" });
    return (
        <Page>
            <PageHeader
                title="Models"
                caption={CAPTIONS[tab]}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setImporting(true)}>
                            Import model
                        </Button>
                        {tab === "mine" && (
                            <Button onClick={() => setCreating(true)}>Create model</Button>
                        )}
                    </>
                }
            />
            <Tabs value={tab} onValueChange={(value) => switchTab(String(value))}>
                <TabsList variant="line">
                    <TabsTrigger value="mine">My models</TabsTrigger>
                    <TabsTrigger value="discover">Discover</TabsTrigger>
                </TabsList>
            </Tabs>
            {tab === "mine" ? (
                <MyModels
                    search={search}
                    update={update}
                    onDiscover={() => switchTab("discover")}
                    onCreate={() => setCreating(true)}
                />
            ) : (
                <Discover search={search} update={update} onImport={() => setImporting(true)} />
            )}
            <CreateModelDialog open={creating} onOpenChange={setCreating} />
            <ImportModelDialog open={importing} onOpenChange={setImporting} />
        </Page>
    );
}
