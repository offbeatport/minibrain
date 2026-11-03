import { ThumbsUp } from "lucide-react";
import { Link } from "obp-ui";
import { CopyButton } from "~/components/CopyButton";
import { PanelSection } from "~/components/Section";
import { feedbackForModel } from "~/lib/feedback";

function feedbackCurl(baseUrl: string, model: string, key: string): string {
    const body = {
        model,
        response_id: "chatcmpl-abc123",
        rating: "down",
        correction: "billing",
        input: "I was charged twice",
    };
    return [
        `curl ${baseUrl}/feedback \\`,
        `  -H "Authorization: Bearer ${key}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify(body, null, 4).replaceAll("\n", "\n  ")}'`,
    ].join("\n");
}

export function FeedbackApi({
    baseUrl,
    model,
    slug,
    keyValue,
}: {
    baseUrl: string;
    model: string;
    slug: string;
    keyValue: string | null;
}) {
    const code = feedbackCurl(baseUrl, model, keyValue ?? "YOUR_KEY");
    return (
        <PanelSection
            icon={ThumbsUp}
            title="Feedback"
            description="Tell the model when an answer was right or wrong; it lands in the review queue."
        >
            <div className="flex flex-col gap-3 text-sm">
                <p>
                    <span className="font-mono">POST {baseUrl}/feedback</span> with the{" "}
                    <span className="font-mono">id</span> of the chat completion as{" "}
                    <span className="font-mono">response_id</span>, a{" "}
                    <span className="font-mono">rating</span> of{" "}
                    <span className="font-mono">up</span> or <span className="font-mono">down</span>
                    , and optionally the right answer as{" "}
                    <span className="font-mono">correction</span> and a{" "}
                    <span className="font-mono">comment</span>. The key must cover this model.
                </p>
                <p className="text-muted-foreground">
                    Send <span className="font-mono">input</span>, the user message, unless{" "}
                    <Link href="/settings/security" className="text-primary hover:underline">
                        Security
                    </Link>{" "}
                    keeps request inputs and answers; then the response ID alone is enough. Accepted
                    answers from{" "}
                    <Link href={feedbackForModel(slug)} className="text-primary hover:underline">
                        Feedback
                    </Link>{" "}
                    join the next training data.
                </p>
                <div className="relative">
                    <pre className="overflow-x-auto rounded-md border bg-secondary p-3 pr-12 font-mono text-sm">
                        {code}
                    </pre>
                    <div className="absolute top-1 right-1">
                        <CopyButton value={code} label="Copy the feedback call" />
                    </div>
                </div>
            </div>
        </PanelSection>
    );
}
