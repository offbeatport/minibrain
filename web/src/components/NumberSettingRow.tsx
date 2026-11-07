import { Button, NumberField, type NumberFieldProps, SettingsRow } from "obp-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { errorMessage } from "~/components/Section";
import { SourceBadge } from "~/components/SourceBadge";

type NumberOptions = Pick<
    NumberFieldProps,
    "min" | "max" | "step" | "largeStep" | "format" | "unit" | "groupClassName"
>;

export function NumberSettingRow({
    id,
    anchor,
    label,
    description,
    value,
    pending,
    error,
    onSave,
    locked,
    ...options
}: NumberOptions & {
    id: string;
    anchor?: string;
    label: ReactNode;
    description?: ReactNode;
    value: number | undefined;
    pending: boolean;
    error: unknown;
    onSave: (value: number, saved: () => void) => void;
    locked?: string | null;
}) {
    const [draft, setDraft] = useState<number | null | undefined>(undefined);
    const shown = draft === undefined ? (value ?? null) : draft;
    const dirty = draft !== undefined && draft !== value;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (dirty && draft !== null) {
            onSave(draft, () => setDraft(undefined));
        }
    };
    if (locked) {
        const text =
            value === undefined
                ? ""
                : new Intl.NumberFormat(undefined, options.format).format(value);
        return (
            <SettingsRow
                anchor={anchor}
                label={label}
                description={description}
                disabled
                control={
                    <>
                        <span className="tabular-nums">
                            {text}
                            {options.unit && (
                                <span className="text-muted-foreground"> {options.unit}</span>
                            )}
                        </span>
                        <SourceBadge source={locked} />
                    </>
                }
            />
        );
    }
    return (
        <form onSubmit={submit} noValidate>
            <SettingsRow
                id={id}
                anchor={anchor}
                label={label}
                description={description}
                error={errorMessage(error)}
                control={
                    <>
                        <NumberField
                            id={id}
                            value={shown}
                            onValueChange={setDraft}
                            aria-describedby={description ? `${id}-description` : undefined}
                            {...options}
                        />
                        {dirty && (
                            <Button type="submit" disabled={pending || draft === null}>
                                Save
                            </Button>
                        )}
                    </>
                }
            />
        </form>
    );
}
