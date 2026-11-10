import { Button, CubePlus, Link } from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { ModelsFlowList } from "./ModelsFlowList";
import { useCan } from "./flowOverlays";
import { FLOW } from "./modelsFlowData";

export function ModelsFlowPage() {
    const can = useCan("builder");
    return (
        <Page wide>
            <PageHeader
                title="Models"
                caption="One row per model. Turn on Show versions in view options to list versions and formats under each."
                actions={
                    can && (
                        <Button asChild>
                            <Link href={`${FLOW}/models/new`}>
                                <CubePlus />
                                Add model
                            </Link>
                        </Button>
                    )
                }
            />
            <ModelsFlowList />
        </Page>
    );
}
