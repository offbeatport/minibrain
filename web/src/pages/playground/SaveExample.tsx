import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    useToast,
} from "obp-ui";
import { type FormEvent, useState } from "react";
import { useSaveTestExample } from "~/api/feedbackQueries";
import { ErrorLine } from "~/components/Section";
import { type Target, type Turn, exampleTurns } from "~/lib/playground";

const SHOWN_TURNS = 4;

function Transcript({ turns }: { turns: { role: string; content: string }[] }) {
    const hidden = Math.max(0, turns.length - SHOWN_TURNS);
    return (
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border p-3">
            {hidden > 0 && (
                <p className="text-sm text-muted-foreground">
                    {`${hidden} earlier ${hidden === 1 ? "turn" : "turns"}`}
                </p>
            )}
            {turns.slice(-SHOWN_TURNS).map((turn, index) => (
                <p key={`${index}-${turn.role}`} className="whitespace-pre-wrap">
                    <span className="text-muted-foreground">
                        {turn.role === "user" ? "User: " : "Assistant: "}
                    </span>
                    {turn.content}
                </p>
            ))}
        </div>
    );
}

export function SaveExample({
    target,
    turns,
    answerId,
    onClose,
}: {
    target: Target;
    turns: Turn[];
    answerId: string | null;
    onClose: () => void;
}) {
    const toast = useToast();
    const save = useSaveTestExample(target.key);
    const answer = turns.find((turn) => turn.id === answerId);
    const output = answer?.kind === "assistant" ? answer.content : "";
    const messages = answerId ? exampleTurns(turns, answerId) : null;
    const labels = target.labels;
    const [expected, setExpected] = useState(() =>
        labels.length > 0 && !labels.includes(output) ? "" : output,
    );
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!messages || !expected.trim()) {
            return;
        }
        save.mutate(
            {
                messages,
                expected: expected.trim(),
                output: output || null,
                version: target.version ?? null,
                response_id:
                    answer?.kind === "assistant" ? (answer.meta?.responseId ?? null) : null,
            },
            {
                onSuccess: () => {
                    onClose();
                    toast({
                        title: "Saved as a test example",
                        description: `It joins the held-out rows when the next version of ${target.model_name} starts.`,
                        tone: "success",
                    });
                },
            },
        );
    };
    return (
        <Dialog open={answerId !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <form onSubmit={submit} className="flex flex-col gap-6">
                    <DialogHeader>
                        <DialogTitle>Save as a test example</DialogTitle>
                        <DialogDescription>
                            {`Adds this conversation to ${target.model_name}'s data as a held-out example, so the next version is scored on it. Fix the expected answer if the model got it wrong.`}
                        </DialogDescription>
                    </DialogHeader>
                    {messages ? (
                        <Transcript turns={messages} />
                    ) : (
                        <p className="text-muted-foreground">
                            Only conversations of plain messages can be test examples, without tool
                            calls.
                        </p>
                    )}
                    {labels.length > 0 ? (
                        <Field id="example-expected" label="Expected answer">
                            <Select
                                value={expected}
                                onValueChange={(next) => setExpected(String(next ?? ""))}
                            >
                                <SelectTrigger id="example-expected" className="w-full">
                                    <SelectValue placeholder="Pick the right label" />
                                </SelectTrigger>
                                <SelectContent>
                                    {labels.map((label) => (
                                        <SelectItem key={label} value={label}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    ) : (
                        <Field
                            id="example-expected"
                            label="Expected answer"
                            hint="Starts as the model's answer."
                        >
                            <Textarea
                                id="example-expected"
                                rows={6}
                                value={expected}
                                onChange={(event) => setExpected(event.target.value)}
                                className={target.contract === "json" ? "font-mono" : undefined}
                            />
                        </Field>
                    )}
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={save.isPending || !messages || !expected.trim()}
                        >
                            Save test example
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
