import { Dices } from "lucide-react";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Kbd,
} from "obp-ui";
import { type KeyboardEvent, useState } from "react";
import "./avatarPicker.css";
import {
    CandidateGrid,
    ColourRow,
    ContextStrip,
    CustomLetters,
    HeroStage,
    RecentStrip,
    StylePicker,
} from "./AvatarPickerParts";
import { AvatarTile } from "./AvatarTile";
import {
    CUSTOM_LETTERS,
    GRID_SIZE,
    type Session,
    choose,
    deal,
    describe,
    draftOf,
    finalChoice,
    pickStyle,
    recolour,
    remember,
    selectCustomLetters,
    shapeChoices,
    startSession,
    surprise,
    withLetters,
} from "./avatarSession";
import { styleById } from "./avatarStyles";
import { type AvatarChoice, defaultLetters, sameChoice } from "./avatarSvg";

export function isTyping(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    );
}

function editsText(target: EventTarget): boolean {
    return (
        isTyping(target) &&
        !(target instanceof HTMLInputElement && ["radio", "checkbox"].includes(target.type))
    );
}

function modified(event: KeyboardEvent): boolean {
    return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

function activates(target: EventTarget): boolean {
    return (
        target instanceof HTMLButtonElement ||
        target instanceof HTMLAnchorElement ||
        target instanceof HTMLTextAreaElement
    );
}

export function PickerDialog({
    open,
    onOpenChange,
    name,
    value,
    onUse,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    value: AvatarChoice;
    onUse: (choice: AvatarChoice) => void;
}) {
    const [session, setSession] = useState(() => startSession(value));
    const [peek, setPeek] = useState<AvatarChoice | null>(null);
    const [shownOpen, setShownOpen] = useState(open);
    if (open !== shownOpen) {
        setShownOpen(open);
        if (open) {
            setSession(startSession(value));
            setPeek(null);
        }
    }
    const displayName = name.trim() || "Untitled model";
    const style = styleById(session.style);
    const draft = draftOf(session);
    const shown = peek ?? draft;
    const previewing = peek !== null && !sameChoice(peek, draft);
    const update = (change: (previous: Session) => Session) => {
        setPeek(null);
        setSession(change);
    };
    const pick = (choice: AvatarChoice) => update((previous) => choose(previous, choice));
    const fallback = defaultLetters(displayName);
    const use = (choice: AvatarChoice) => {
        const picked = finalChoice(choice);
        remember(picked);
        onUse(picked);
        onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.defaultPrevented || modified(event)) {
            return;
        }
        if (event.key.toLowerCase() === "r" && !editsText(event.target)) {
            event.preventDefault();
            update(deal);
        } else if (event.key === "Enter" && !activates(event.target)) {
            event.preventDefault();
            use(draft);
        }
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-5xl" onKeyDown={onKeyDown}>
                <DialogHeader>
                    <DialogTitle>Choose an avatar</DialogTitle>
                    <DialogDescription>
                        For {displayName}. Pick a style, then a shape, then a colour.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-6 lg:grid lg:grid-cols-[24rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:gap-y-4">
                    <div className="min-w-0 lg:col-start-1 lg:row-start-1">
                        <HeroStage shown={shown} previewing={previewing} name={displayName} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
                        <StylePicker
                            value={session.style}
                            name={displayName}
                            action={
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => update(surprise)}
                                >
                                    Surprise me
                                </Button>
                            }
                            onChange={(next) => update((previous) => pickStyle(previous, next))}
                        />
                        <CandidateGrid
                            detail={
                                style.seeded
                                    ? `${style.name}, ${GRID_SIZE} options`
                                    : "Letters from the name, or your own"
                            }
                            action={
                                style.seeded && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => update(deal)}
                                    >
                                        <Dices aria-hidden="true" />
                                        Shuffle
                                        <Kbd className="hidden sm:inline-flex">R</Kbd>
                                    </Button>
                                )
                            }
                            items={shapeChoices(session)}
                            selected={draft}
                            name={displayName}
                            dealt={session.deal}
                            onPeek={setPeek}
                            onSelect={pick}
                            onUse={use}
                        >
                            {!style.seeded && (
                                <CustomLetters
                                    letters={session.letters}
                                    fallback={fallback}
                                    selected={session.shapes.initials === CUSTOM_LETTERS}
                                    onChange={(letters) =>
                                        update((previous) => withLetters(previous, letters))
                                    }
                                    onSelect={() => update(selectCustomLetters)}
                                />
                            )}
                        </CandidateGrid>
                        <ColourRow
                            tone={draft.tone}
                            onPeek={(tone) => setPeek(tone ? { ...draft, tone } : null)}
                            onPick={(tone) => update((previous) => recolour(previous, tone))}
                        />
                        <RecentStrip
                            items={session.recent}
                            selected={draft}
                            name={displayName}
                            onPeek={setPeek}
                            onSelect={pick}
                        />
                    </div>
                    <div className="min-w-0 lg:col-start-1 lg:row-start-2">
                        <ContextStrip choice={shown} name={displayName} />
                    </div>
                </div>
                <DialogFooter className="max-sm:sticky max-sm:-bottom-7 max-sm:-mx-7 max-sm:-mb-7 max-sm:grid max-sm:grid-cols-2 max-sm:border-t max-sm:bg-card max-sm:px-7 max-sm:py-4 sm:items-center">
                    <p
                        aria-live="polite"
                        className="flex min-w-0 items-center gap-2 max-sm:col-span-2 sm:mr-auto"
                        data-testid="avatar-summary"
                    >
                        <span className="text-muted-foreground">Saves</span>
                        <AvatarTile choice={draft} name={displayName} size="sm" />
                        <span className="truncate font-medium">{describe(draft, displayName)}</span>
                    </p>
                    <DialogClose render={<Button variant="outline">Cancel</Button>} />
                    <Button type="button" onClick={() => use(draft)}>
                        Use avatar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
