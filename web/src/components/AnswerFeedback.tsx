import { ThumbsDown, ThumbsUp } from "lucide-react";
import {
    Button,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    useToast,
} from "obp-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { useSendFeedback } from "~/api/feedbackQueries";
import { ErrorLine } from "~/components/Section";

type Rating = "up" | "down";

export type Answered = { id: string; model: string; output: string };

function versionOf(model: string): number | null {
    const number = Number(model.split("@")[1]);
    return Number.isInteger(number) ? number : null;
}

function RateButton({
    rating,
    chosen,
    onClick,
    disabled,
}: {
    rating: Rating;
    chosen: boolean;
    onClick: () => void;
    disabled: boolean;
}) {
    const Icon = rating === "up" ? ThumbsUp : ThumbsDown;
    const label = rating === "up" ? "Right answer" : "Wrong answer";
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant={chosen ? "secondary" : "ghost"}
                    size="icon"
                    aria-label={label}
                    aria-pressed={chosen}
                    onClick={onClick}
                    disabled={disabled}
                >
                    <Icon aria-hidden="true" className={chosen ? "fill-current" : undefined} />
                </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

function Correction({
    labels,
    onSend,
    onCancel,
    busy,
}: {
    labels: string[];
    onSend: (value: string) => void;
    onCancel: () => void;
    busy: boolean;
}) {
    const [value, setValue] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (value.trim()) {
            onSend(value.trim());
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            {labels.length > 0 ? (
                <Select value={value} onValueChange={(next) => setValue(String(next ?? ""))}>
                    <SelectTrigger aria-label="Right answer" className="w-48">
                        <SelectValue placeholder="Right answer" />
                    </SelectTrigger>
                    <SelectContent>
                        {labels.map((label) => (
                            <SelectItem key={label} value={label}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                <Input
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Right answer"
                    aria-label="Right answer"
                    className="w-64"
                    autoFocus
                />
            )}
            <Button type="submit" disabled={busy || !value.trim()}>
                Send correction
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
            </Button>
        </form>
    );
}

export function AnswerFeedback({
    slug,
    input,
    reply,
    labels,
    actions,
}: {
    slug: string;
    input: string;
    reply: Answered;
    labels: string[];
    actions?: ReactNode;
}) {
    const toast = useToast();
    const send = useSendFeedback(slug);
    const [rating, setRating] = useState<Rating | null>(null);
    const [correcting, setCorrecting] = useState(false);
    const rate = (next: Rating, correction?: string) =>
        send.mutate(
            {
                rating: next,
                input,
                output: reply.output,
                correction: correction ?? null,
                version: versionOf(reply.model),
                response_id: reply.id,
            },
            {
                onSuccess: () => {
                    setRating(next);
                    setCorrecting(false);
                    toast({
                        title: correction
                            ? "Correction sent for review"
                            : next === "up"
                              ? "Marked right"
                              : "Marked wrong",
                        description: "It is waiting on Feedback for a reviewer.",
                        tone: "success",
                    });
                },
            },
        );
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1">
                <RateButton
                    rating="up"
                    chosen={rating === "up"}
                    onClick={() => rate("up")}
                    disabled={send.isPending}
                />
                <RateButton
                    rating="down"
                    chosen={rating === "down"}
                    onClick={() => rate("down")}
                    disabled={send.isPending}
                />
                <Button variant="ghost" onClick={() => setCorrecting(true)} disabled={correcting}>
                    Correct it
                </Button>
                {actions}
            </div>
            {correcting && (
                <Correction
                    labels={labels}
                    onSend={(value) => rate("down", value)}
                    onCancel={() => setCorrecting(false)}
                    busy={send.isPending}
                />
            )}
            <ErrorLine error={send.error} />
        </div>
    );
}
