import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { Fragment, type ReactNode } from "react";

export type PickOption = {
    value: string;
    label: ReactNode;
    meta?: ReactNode;
    disabled?: boolean;
    separated?: boolean;
};

export function PickSelect({
    id,
    value,
    options,
    onChange,
    placeholder,
    invalid,
    disabled,
}: {
    id: string;
    value: string | null;
    options: PickOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
}) {
    return (
        <Select
            value={value}
            disabled={disabled}
            onValueChange={(next) => next !== null && onChange(String(next))}
        >
            <SelectTrigger
                id={id}
                aria-invalid={invalid || undefined}
                className="w-full max-sm:[&_[data-pick-meta]]:hidden"
            >
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <Fragment key={option.value}>
                        {option.separated && <SelectSeparator />}
                        <SelectItem value={option.value} disabled={option.disabled}>
                            <span className="truncate">{option.label}</span>
                            {option.meta && (
                                <span
                                    data-pick-meta
                                    className="ml-auto truncate pl-4 text-sm text-muted-foreground tabular-nums"
                                >
                                    {option.meta}
                                </span>
                            )}
                        </SelectItem>
                    </Fragment>
                ))}
            </SelectContent>
        </Select>
    );
}
