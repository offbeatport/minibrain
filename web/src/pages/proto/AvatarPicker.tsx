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
    Tabs,
    TabsList,
    TabsTrigger,
    cn,
} from "obp-ui";
import { useEffect, useState } from "react";
import "./avatarPicker.css";
import {
    CandidateGrid,
    ColourRow,
    ContextStrip,
    HeroStage,
    LettersField,
    RecentStrip,
} from "./AvatarPickerParts";
import { type AvatarChoice, AvatarTile, defaultLetters, sameChoice } from "./avatarDicebear";
import {
    type Session,
    choose,
    deal,
    describe,
    draftOf,
    finalChoice,
    mixColours,
    recolour,
    remember,
    startSession,
    surprise,
    withLetters,
} from "./avatarSession";
import { AVATAR_STYLES, type AvatarStyleId, styleById } from "./avatarStyles";

export function isTyping(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    );
}

function plainKey(event: globalThis.KeyboardEvent): boolean {
    return !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target);
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
    const displayName = name.trim() || "Untitled model";
    const style = styleById(session.tab);
    const draft = draftOf(session);
    const shown = peek ?? draft;
    const previewing = peek !== null && !sameChoice(peek, draft);
    const update = (change: (previous: Session) => Session) => {
        setPeek(null);
        setSession(change);
    };
    const pick = (choice: AvatarChoice) => update((previous) => choose(previous, choice));
    const use = (choice: AvatarChoice) => {
        const picked = finalChoice(choice);
        remember(picked);
        onUse(picked);
        onOpenChange(false);
    };
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key.toLowerCase() === "r" && plainKey(event)) {
                event.preventDefault();
                setPeek(null);
                setSession(deal);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (next) {
                    setSession(startSession(value));
                    setPeek(null);
                }
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>Choose an avatar</DialogTitle>
                    <DialogDescription>
                        For {displayName}. Hover to preview, click to pick.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-6 lg:grid lg:grid-cols-[24rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:gap-y-4">
                    <div className="min-w-0 lg:col-start-1 lg:row-start-1">
                        <HeroStage shown={shown} previewing={previewing} name={displayName} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
                        <Tabs
                            value={session.tab}
                            onValueChange={(tab) =>
                                update((previous) => ({ ...previous, tab: tab as AvatarStyleId }))
                            }
                        >
                            <TabsList
                                variant="line"
                                aria-label="Style"
                                className="w-full justify-start gap-0 overflow-x-auto border-b"
                            >
                                {AVATAR_STYLES.map((item) => (
                                    <TabsTrigger
                                        key={item.id}
                                        value={item.id}
                                        className="h-11 flex-none gap-2.5 px-3 text-base sm:px-4"
                                    >
                                        <AvatarTile
                                            choice={session.selected[item.id]}
                                            name={displayName}
                                            size="md"
                                            className="hidden sm:flex"
                                        />
                                        {item.name}
                                    </TabsTrigger>
                                ))}
                            </TabsList>
                        </Tabs>
                        <CandidateGrid
                            label={style.seeded ? `${style.name} options` : `${style.name} colours`}
                            items={session.batches[session.tab]}
                            selected={draft}
                            name={displayName}
                            dealt={session.deal}
                            onPeek={setPeek}
                            onSelect={pick}
                            onUse={use}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => update(deal)}
                                disabled={!style.seeded}
                                className={cn(!style.seeded && "invisible max-sm:hidden")}
                                aria-hidden={!style.seeded || undefined}
                            >
                                <Dices aria-hidden="true" />
                                Shuffle
                                <Kbd className="hidden sm:inline-flex">R</Kbd>
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => update(surprise)}
                                className="sm:ml-auto"
                            >
                                Surprise me
                            </Button>
                        </div>
                        {style.seeded ? (
                            <ColourRow
                                tone={draft.tone}
                                pinned={session.pin !== null}
                                onPeek={(tone) => setPeek(tone ? { ...draft, tone } : null)}
                                onPick={(tone) => update((previous) => recolour(previous, tone))}
                                onMix={() => update(mixColours)}
                            />
                        ) : (
                            <LettersField
                                letters={session.letters}
                                fallback={defaultLetters(displayName)}
                                onChange={(letters) =>
                                    update((previous) => withLetters(previous, letters))
                                }
                            />
                        )}
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
