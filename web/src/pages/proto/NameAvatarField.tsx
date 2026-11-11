import { Dices, Lock } from "lucide-react";
import { Button, Input, Kbd, Label, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PickerDialog, isTyping } from "./AvatarPicker";
import "./avatarPicker.css";
import {
    type AvatarChoice,
    AvatarTile,
    randomTone,
    rerollChoice,
    sameChoice,
} from "./avatarDicebear";
import { generateName } from "./avatarNames";

export type Identity = { name: string; avatar: AvatarChoice };

type Locks = { name: string | null; avatar: AvatarChoice | null };

export function newIdentity(taken: string[]): Identity {
    return {
        name: generateName(taken),
        avatar: { style: "initials", seed: "initials", tone: randomTone() },
    };
}

function shuffleLabel(locks: Locks): string {
    if (locks.name !== null && locks.avatar !== null) {
        return "Both are yours now. Undo one to shuffle again";
    }
    if (locks.name !== null) {
        return "Shuffle the avatar";
    }
    if (locks.avatar !== null) {
        return "Shuffle the name";
    }
    return "Shuffle name and avatar";
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
    children,
}: {
    id: string;
    value: Identity;
    onChange: (next: Identity) => void;
    taken: string[];
    children?: ReactNode;
}) {
    const [locks, setLocks] = useState<Locks>({ name: null, avatar: null });
    const [picking, setPicking] = useState(false);
    const [dealt, setDealt] = useState(0);
    const display = value.name.trim() || "Untitled model";
    const bothLocked = locks.name !== null && locks.avatar !== null;
    const latest = useRef({ value, locks, taken, onChange });
    latest.current = { value, locks, taken, onChange };
    const shuffle = () => {
        const { value: current, locks: held, taken: names, onChange: emit } = latest.current;
        if (held.name !== null && held.avatar !== null) {
            return;
        }
        emit({
            name: held.name !== null ? current.name : generateName([...names, current.name]),
            avatar: held.avatar !== null ? current.avatar : rerollChoice(current.avatar),
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
    const undoAvatar = () => {
        if (locks.avatar !== null) {
            onChange({ ...value, avatar: locks.avatar });
            setLocks((held) => ({ ...held, avatar: null }));
        }
    };
    const label = shuffleLabel(locks);
    return (
        <div data-testid="name-row" className="flex flex-col gap-label">
            <Label htmlFor={id}>Name</Label>
            <div className="flex items-center gap-2">
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
                                size="md"
                                className="avatar-fade"
                            />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>Change avatar</TooltipContent>
                </Tooltip>
                <div className="relative min-w-0 flex-1">
                    <Input
                        key={`name-${dealt}`}
                        id={id}
                        value={value.name}
                        autoComplete="off"
                        spellCheck={false}
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
            <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {locks.name === null && locks.avatar === null && (
                    <span>Name it after what it does, like Ticket router or Invoice reader.</span>
                )}
                {locks.name !== null && (
                    <LockNote what="Name" previous={locks.name} onUndo={undoName} />
                )}
                {locks.avatar !== null && (
                    <LockNote what="Avatar" previous="the last one" onUndo={undoAvatar} />
                )}
            </div>
            {children}
            <PickerDialog
                open={picking}
                onOpenChange={setPicking}
                name={display}
                value={value.avatar}
                onUse={applyAvatar}
            />
        </div>
    );
}
