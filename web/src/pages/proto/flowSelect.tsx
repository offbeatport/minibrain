import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { Fragment, type ReactNode } from "react";

export type RichOption = {
    value: string;
    label: ReactNode;
    meta?: ReactNode;
    icon?: ReactNode;
    disabled?: boolean;
    separated?: boolean;
};

export function RichSelect({
    id,
    label,
    value,
    options,
    onChange,
    placeholder,
}: {
    id: string;
    label: string;
    value: string | null;
    options: RichOption[];
    onChange: (value: string) => void;
    placeholder?: string;
}) {
    return (
        <Select
            value={value}
            onValueChange={(next) => {
                if (next !== null) {
                    onChange(String(next));
                }
            }}
        >
            <SelectTrigger id={id} aria-label={label} className="w-full">
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <Fragment key={option.value}>
                        {option.separated && <SelectSeparator />}
                        <SelectItem
                            value={option.value}
                            disabled={option.disabled}
                            icon={option.icon}
                        >
                            <span className="truncate">{option.label}</span>
                            {option.meta && (
                                <span className="ml-auto truncate pl-4 text-sm text-muted-foreground tabular-nums">
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
