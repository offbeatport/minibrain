import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Field,
    Markdown,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useState } from "react";
import type { RecipeInfo, RecipeSample } from "~/api/client";

const NONE = "none";

type Chosen = { key: string; name: string; sample: RecipeSample };

function stripTitle(readme: string): string {
    return readme.replace(/^# .*\n+/, "");
}

export function RecipePicker({
    recipes,
    chosen,
    loading,
    onPick,
    onClear,
}: {
    recipes: RecipeInfo[];
    chosen: Chosen | null;
    loading: boolean;
    onPick: (key: string) => void;
    onClear: () => void;
}) {
    const [reading, setReading] = useState<RecipeInfo | null>(null);
    const current = recipes.find((item) => item.key === chosen?.key);
    if (recipes.length === 0) {
        return null;
    }
    return (
        <>
            <Field
                id="create-recipe"
                label="Start from a recipe (optional)"
                hint={
                    chosen
                        ? `Loaded ${chosen.sample.dataset_name}: ${chosen.sample.rows.toLocaleString()} synthetic rows, ${chosen.sample.labels.length} labels. Swap in your own data later.`
                        : "A worked use case with a small sample dataset, to try before using real data."
                }
            >
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={chosen?.key ?? NONE}
                        onValueChange={(next) => {
                            const key = String(next ?? NONE);
                            if (key === NONE) {
                                onClear();
                            } else {
                                onPick(key);
                            }
                        }}
                        disabled={loading}
                    >
                        <SelectTrigger id="create-recipe" className="w-full max-w-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NONE}>None</SelectItem>
                            {recipes.map((item) => (
                                <SelectItem
                                    key={item.key}
                                    value={item.key}
                                    description={item.summary}
                                >
                                    {item.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {loading && (
                        <span className="text-sm text-muted-foreground">Loading the sample…</span>
                    )}
                    {current && (
                        <Button type="button" variant="ghost" onClick={() => setReading(current)}>
                            Read the recipe
                        </Button>
                    )}
                </div>
            </Field>
            <Dialog open={reading !== null} onOpenChange={(open) => !open && setReading(null)}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{reading?.name}</DialogTitle>
                    </DialogHeader>
                    {reading && <Markdown content={stripTitle(reading.readme)} />}
                </DialogContent>
            </Dialog>
        </>
    );
}
