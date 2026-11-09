import { Button, CubePlus, Link } from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { ModelsFlowList } from "./ModelsFlowList";
import { FLOW } from "./modelsFlowData";

export function ModelsFlowPage() {
    return (
        <Page wide>
            <PageHeader
                title="Models"
                caption="Custom and base models, each with its newest versions. A model or version opens its one page."
                actions={
                    <Button asChild>
                        <Link href={`${FLOW}/models/new`}>
                            <CubePlus />
                            Add model
                        </Link>
                    </Button>
                }
            />
            <ModelsFlowList />
        </Page>
    );
}
