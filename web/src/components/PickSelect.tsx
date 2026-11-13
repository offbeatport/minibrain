import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
    cn,
} from "obp-ui";
import { Fragment, type ReactNode } from "react";

export type PickOption = {
    value: string;
    label: ReactNode;
    meta?: ReactNode;
    icon?: ReactNode;
    description?: ReactNode;
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
    compact,
    menuClassName,
    large,
}: {
    id: string;
    value: string | null;
    options: PickOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
    compact?: boolean;
    menuClassName?: string;
    large?: boolean;
}) {
    const selected = large ? options.find((option) => option.value === value) : undefined;
    return (
        <Select
            value={value}
            disabled={disabled}
            onValueChange={(next) => next !== null && onChange(String(next))}
        >
            <SelectTrigger
                id={id}
                aria-invalid={invalid || undefined}
                className={cn(
                    "w-full",
                    large && "h-auto min-h-12 px-3 py-1.5",
                    compact ? "[&_[data-pick-meta]]:hidden" : "max-sm:[&_[data-pick-meta]]:hidden",
                )}
            >
                {selected ? (
                    <span className="flex min-w-0 items-center gap-2.5">
                        {selected.icon && (
                            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5">
                                {selected.icon}
                            </span>
                        )}
                        <span className="flex min-w-0 flex-col items-start text-left">
                            <span className="truncate">{selected.label}</span>
                            {selected.description && (
                                <span className="truncate text-sm text-muted-foreground">
                                    {selected.description}
                                </span>
                            )}
                        </span>
                    </span>
                ) : (
                    <SelectValue placeholder={placeholder} />
                )}
            </SelectTrigger>
            <SelectContent className={menuClassName}>
                {options.map((option) => (
                    <Fragment key={option.value}>
                        {option.separated && <SelectSeparator />}
                        <SelectItem
                            value={option.value}
                            disabled={option.disabled}
                            icon={option.icon}
                            description={option.description}
                            className={
                                large
                                    ? "gap-3 py-2.5 pl-3 [&_[data-slot=select-item-icon]]:size-5 [&_[data-slot=select-item-icon]_svg]:size-5"
                                    : undefined
                            }
                        >
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
