import { Dices } from "lucide-react";
import { Button, Input, Kbd, Label, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { generateName } from "~/lib/avatarNames";
import { PickerDialog, isTyping } from "./AvatarPicker";
import { AvatarTile } from "./AvatarTile";
import "./avatarPicker.css";
import { type AvatarChoice, TWO_LETTERS, randomTone, sameChoice } from "./avatarSvg";

export type Identity = { name: string; avatar: AvatarChoice };

export type NameTaken = (name: string) => boolean;

export function newIdentity(taken: NameTaken): Identity {
    return {
        name: generateName(taken),
        avatar: { style: "initials", seed: TWO_LETTERS, tone: randomTone() },
    };
}

function shuffleLabel(): string {
    return "Shuffle the name";
}

export function NameAvatarField({
    id,
    value,
    onChange,
    taken,
    error,
    labelled = true,
    rows,
    children,
}: {
    id: string;
    value: Identity;
    onChange: (next: Identity) => void;
    taken: NameTaken;
    error?: string;
    labelled?: boolean;
    rows?: { avatar: (node: ReactNode) => ReactNode; name: (node: ReactNode) => ReactNode };
    children?: ReactNode;
}) {
    const [picking, setPicking] = useState(false);
    const [dealt, setDealt] = useState(0);
    const display = value.name.trim() || "Untitled model";
    const latest = useRef({ value, taken, onChange });
    latest.current = { value, taken, onChange };
    const shuffle = () => {
        const { value: current, taken: isTaken, onChange: emit } = latest.current;
        const previous = current.name.trim().toLowerCase();
        emit({
            name: generateName((name) => isTaken(name) || name.toLowerCase() === previous),
            avatar: current.avatar,
        });
        setDealt((count) => count + 1);
    };
    const shuffleRef = useRef(shuffle);
    shuffleRef.current = shuffle;
    useEffect(() => {
        if (picking) {
            return;
        }
        const onKey = (event: KeyboardEvent) => {
            if (
                event.key.toLowerCase() === "r" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !isTyping(event.target) &&
                !document.querySelector("[role=dialog]")
            ) {
                event.preventDefault();
                shuffleRef.current();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [picking]);
    const rename = (name: string) => {
        onChange({ ...value, name });
    };
    const applyAvatar = (avatar: AvatarChoice) => {
        if (sameChoice(avatar, value.avatar)) {
            return;
        }
        onChange({ ...value, avatar });
    };
    const avatarButton = (size: "md" | "field") => (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label="Change avatar"
                    aria-haspopup="dialog"
                    onClick={() => setPicking(true)}
                    className="shrink-0 rounded-md outline-none hover:ring-1 hover:ring-input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                >
                    <AvatarTile
                        key={`avatar-${dealt}`}
                        choice={value.avatar}
                        name={display}
                        size={size}
                        className="avatar-fade"
                    />
                </button>
            </TooltipTrigger>
            <TooltipContent>Change avatar</TooltipContent>
        </Tooltip>
    );
    const label = shuffleLabel();
    const field = (
        <div data-testid="name-row" className="flex flex-col gap-label">
            {labelled && <Label htmlFor={id}>Name</Label>}
            <div className="flex items-center gap-2">
                {!rows && avatarButton("md")}
                <div className="relative min-w-0 flex-1">
                    <Input
                        key={`name-${dealt}`}
                        id={id}
                        required
                        value={value.name}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={Boolean(error)}
                        onChange={(event) => rename(event.target.value)}
                        className="avatar-fade"
                    />
                </div>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={label}
                            onClick={shuffle}
                        >
                            <Dices aria-hidden="true" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        <span className="flex items-center gap-2">
                            {label}
                            <Kbd>R</Kbd>
                        </span>
                    </TooltipContent>
                </Tooltip>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {children}
        </div>
    );
    const picker = (
        <PickerDialog
            open={picking}
            onOpenChange={setPicking}
            name={display}
            value={value.avatar}
            onUse={applyAvatar}
        />
    );
    if (rows) {
        return (
            <>
                {rows.name(field)}
                {rows.avatar(avatarButton("field"))}
                {picker}
            </>
        );
    }
    return (
        <>
            {field}
            {picker}
        </>
    );
}
