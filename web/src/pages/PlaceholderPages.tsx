import { ComingSoon } from "~/components/PageHeader";

export function PipelinesPage() {
    return (
        <ComingSoon
            title="Pipelines"
            caption="Repeatable runs from a minibrain.yaml."
            body="Each model will be definable as code (source, SQL, steps, recipe, promotion threshold) and rerun from here or from CI."
        />
    );
}
