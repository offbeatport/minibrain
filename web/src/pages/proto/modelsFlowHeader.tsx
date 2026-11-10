import { CircleHelp } from "lucide-react";
import { Button, CubePlus, Kbd, Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { type ReactNode, useId } from "react";
import { FLOW } from "./modelsFlowData";

export function AddModel() {
    return (
        <Button asChild>
            <Link href={`${FLOW}/models/new`}>
                <CubePlus />
                Add model
            </Link>
        </Button>
    );
}

const KEY_INK = "border-current/30 bg-transparent text-current";

export function ShortcutsHelp({ nested }: { nested: boolean }) {
    const id = useId();
    const shortcuts = [
        { keys: ["↑", "↓"], text: "Move" },
        ...(nested ? [{ keys: ["→", "←"], text: "Expand, collapse" }] : []),
        { keys: ["Enter"], text: "Open" },
        {
            keys: ["Space"],
            text: nested ? "Quick look on a model, select a version or variant" : "Quick look",
        },
    ];
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Keyboard shortcuts"
                    aria-describedby={id}
                >
                    <CircleHelp aria-hidden="true" />
                </Button>
            </TooltipTrigger>
            <span id={id} className="sr-only">
                {shortcuts.map((item) => `${item.keys.join(" ")}: ${item.text}.`).join(" ")}
            </span>
            <TooltipContent className="max-w-xs text-left">
                <p className="pb-1 font-medium">Keyboard shortcuts</p>
                <ul className="flex flex-col gap-1 pb-0.5">
                    {shortcuts.map((item) => (
                        <li key={item.text} className="flex items-start gap-2">
                            <span className="flex w-14 shrink-0 gap-0.5">
                                {item.keys.map((key) => (
                                    <Kbd key={key} className={KEY_INK}>
                                        {key}
                                    </Kbd>
                                ))}
                            </span>
                            <span>{item.text}</span>
                        </li>
                    ))}
                </ul>
            </TooltipContent>
        </Tooltip>
    );
}

export function ModelsToolbar({
    search,
    chips,
    actions,
}: {
    search: ReactNode;
    chips: ReactNode;
    actions: ReactNode;
}) {
    return (
        <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {search}
                {chips}
            </div>
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
    );
}
