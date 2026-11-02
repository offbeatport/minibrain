import { Check, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePref, cn, getThemePref, setThemePref } from "obp-ui";
import { useState } from "react";

const MODES: { key: ThemePref; label: string; hint: string; icon: typeof Sun }[] = [
    { key: "light", label: "Light", hint: "Always light", icon: Sun },
    { key: "dark", label: "Dark", hint: "Always dark", icon: Moon },
    { key: "system", label: "System", hint: "Follows your device", icon: Monitor },
];

export function ThemeChoice() {
    const [mode, setMode] = useState<ThemePref>(getThemePref());
    const choose = (key: ThemePref) => {
        setThemePref(key);
        setMode(key);
    };
    return (
        <fieldset className="grid max-w-xl grid-cols-3 gap-3">
            <legend className="sr-only">Theme</legend>
            {MODES.map((option) => {
                const selected = option.key === mode;
                const Icon = option.icon;
                return (
                    <label
                        key={option.key}
                        className={cn(
                            "relative flex cursor-pointer flex-col items-start gap-2 rounded-lg border p-4 has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background",
                            selected
                                ? "border-primary bg-accent text-accent-foreground"
                                : "bg-background hover:bg-secondary",
                        )}
                    >
                        <input
                            type="radio"
                            name="theme"
                            value={option.key}
                            checked={selected}
                            onChange={() => choose(option.key)}
                            className="sr-only"
                        />
                        <Icon
                            aria-hidden="true"
                            className={cn(
                                "size-6",
                                selected ? "text-primary" : "text-muted-foreground",
                            )}
                        />
                        <span className="flex flex-col">
                            <span className="font-semibold">{option.label}</span>
                            <span className="text-sm text-muted-foreground">{option.hint}</span>
                        </span>
                        {selected && (
                            <Check
                                aria-hidden="true"
                                className="absolute top-3 right-3 size-4 text-primary"
                            />
                        )}
                    </label>
                );
            })}
        </fieldset>
    );
}
