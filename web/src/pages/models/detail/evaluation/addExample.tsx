import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    useToast,
} from "obp-ui";
import { type FormEvent, useState } from "react";
import type { ModelDetail } from "~/api/client";
import { useSaveTestExample } from "~/api/feedbackQueries";
import { ErrorLine } from "~/components/Section";

export function AddExampleDialog({
    detail,
    open,
    onOpenChange,
}: {
    detail: ModelDetail;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const toast = useToast();
    const save = useSaveTestExample(detail.slug);
    const [input, setInput] = useState("");
    const [expected, setExpected] = useState("");
    const labels = detail.contract.labels ?? [];
    const close = () => {
        onOpenChange(false);
        setInput("");
        setExpected("");
        save.reset();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!input.trim() || !expected.trim()) {
            return;
        }
        save.mutate(
            {
                messages: [{ role: "user", content: input.trim() }],
                expected: expected.trim(),
                output: null,
                version: null,
                response_id: null,
            },
            {
                onSuccess: () => {
                    close();
                    toast({
                        title: "Test example added",
                        description: `It joins the held-out rows when the next version of ${detail.name} starts.`,
                        tone: "success",
                    });
                },
            },
        );
    };
    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent className="sm:max-w-xl">
                <form onSubmit={submit} className="flex flex-col gap-6">
                    <DialogHeader>
                        <DialogTitle>Add a test example</DialogTitle>
                        <DialogDescription>
                            {`A message and the answer ${detail.name} should give. The next version is scored on it.`}
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        <Field id="example-input" label="Message">
                            <Textarea
                                id="example-input"
                                rows={4}
                                value={input}
                                onChange={(event) => setInput(event.target.value)}
                            />
                        </Field>
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
                            <Field id="example-expected" label="Expected answer">
                                <Textarea
                                    id="example-expected"
                                    rows={4}
                                    value={expected}
                                    onChange={(event) => setExpected(event.target.value)}
                                    className={
                                        detail.contract.kind === "json" ? "font-mono" : undefined
                                    }
                                />
                            </Field>
                        )}
                    </FieldGroup>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={save.isPending || !input.trim() || !expected.trim()}
                        >
                            Add test example
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
