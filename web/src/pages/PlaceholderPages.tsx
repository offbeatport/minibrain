import { ComingSoon } from "~/components/PageHeader";

export function FeedbackPage() {
    return (
        <ComingSoon
            title="Feedback"
            caption="Flagged and corrected outputs from the playground and the API."
            body="Thumbs-down and corrections will land here as a review queue; accepted rows join the next training snapshot."
        />
    );
}

export function PipelinesPage() {
    return (
        <ComingSoon
            title="Pipelines"
            caption="Repeatable runs from a minibrain.yaml."
            body="Each minibrain will be definable as code (source, SQL, steps, recipe, promotion threshold) and rerun from here or from CI."
        />
    );
}
