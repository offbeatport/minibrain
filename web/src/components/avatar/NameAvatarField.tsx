import { Dices, Lock } from "lucide-react";
import { Button, Input, Kbd, Label, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { generateName } from "~/lib/avatarNames";
import { PickerDialog, isTyping } from "./AvatarPicker";
import { AvatarTile } from "./AvatarTile";
import "./avatarPicker.css";
import { type AvatarChoice, TWO_LETTERS, randomTone, sameChoice } from "./avatarSvg";

export type Identity = { name: string; avatar: AvatarChoice };

export type NameTaken = (name: string) => boolean;

type Locks = { name: string | null; avatar: AvatarChoice | null };

export function newIdentity(taken: NameTaken): Identity {
    return {
        name: generateName(taken),
        avatar: { style: "initials", seed: TWO_LETTERS, tone: randomTone() },
    };
}

function shuffleLabel(locks: Locks): string {
    return locks.name !== null ? "Undo the name to shuffle again" : "Shuffle the name";
}

function LockNote({
    what,
    previous,
    onUndo,
}: {
    what: string;
    previous: string;
    onUndo: () => void;
}) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            <span>{what} kept</span>
            <button
                type="button"
                onClick={onUndo}
                aria-label={`Undo ${what.toLowerCase()}, back to ${previous}`}
                className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
                Undo
            </button>
        </span>
    );
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
    const [locks, setLocks] = useState<Locks>({ name: null, avatar: null });
    const [picking, setPicking] = useState(false);
    const [dealt, setDealt] = useState(0);
    const display = value.name.trim() || "Untitled model";
    const bothLocked = locks.name !== null;
    const latest = useRef({ value, locks, taken, onChange });
    latest.current = { value, locks, taken, onChange };
    const shuffle = () => {
        const { value: current, locks: held, taken: isTaken, onChange: emit } = latest.current;
        if (held.name !== null) {
            return;
        }
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
        setLocks((held) => (held.name === null ? { ...held, name: value.name } : held));
        onChange({ ...value, name });
    };
    const applyAvatar = (avatar: AvatarChoice) => {
        if (sameChoice(avatar, value.avatar)) {
            return;
        }
        setLocks((held) => (held.avatar === null ? { ...held, avatar: value.avatar } : held));
        onChange({ ...value, avatar });
    };
    const undoName = () => {
        if (locks.name !== null) {
            onChange({ ...value, name: locks.name });
            setLocks((held) => ({ ...held, name: null }));
        }
    };
    const avatarButton = (size: "md" | "xl") => (
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
    const label = shuffleLabel(locks);
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
                        className={cn("avatar-fade", locks.name !== null && "pr-8")}
                    />
                    {locks.name !== null && (
                        <Lock
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                        />
                    )}
                </div>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={label}
                            aria-disabled={bothLocked}
                            onClick={shuffle}
                            className={cn(bothLocked && "opacity-50 hover:bg-card")}
                        >
                            <Dices aria-hidden="true" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        <span className="flex items-center gap-2">
                            {label}
                            {!bothLocked && <Kbd>R</Kbd>}
                        </span>
                    </TooltipContent>
                </Tooltip>
            </div>
            {locks.name !== null && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <LockNote what="Name" previous={locks.name} onUndo={undoName} />
                </div>
            )}
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
                {rows.avatar(avatarButton("xl"))}
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
