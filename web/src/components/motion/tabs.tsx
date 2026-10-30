"use client";
import { EASE_OUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
    MotionConfig,
    type MotionValue,
    type Transition,
    cancelFrame,
    frame,
    motion,
    useReducedMotion,
    useSpring,
} from "motion/react";
import {
    type ButtonHTMLAttributes,
    type HTMLAttributes,
    type KeyboardEvent,
    type ReactNode,
    createContext,
    useCallback,
    useContext,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
type Variant = "pill" | "underline" | "segment";
type IconDisplay = "always" | "selected";
type Ctx = {
    value: string;
    setValue: (v: string) => void;
    layoutId: string;
    variant: Variant;
    icons: IconDisplay;
    track: Track;
    placed: boolean;
    setPlaced: (placed: boolean) => void;
    tabStop: string | null;
    registerTab: (value: string, disabled: boolean) => void;
    unregisterTab: (value: string) => void;
    panels: ReadonlySet<string>;
    registerPanel: (value: string) => void;
    unregisterPanel: (value: string) => void;
    tabId: (value: string) => string;
    panelId: (value: string) => string;
};
type Track = Record<"x" | "y" | "width" | "height", MotionValue<number>>;
const TabsCtx = createContext<Ctx | null>(null);
function useTabs() {
    const ctx = useContext(TabsCtx);
    if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>");
    return ctx;
}
const transition: Transition = {
    type: "spring",
    stiffness: 245,
    damping: 36,
    mass: 1.2,
};
export function Tabs({
    defaultValue,
    value,
    onValueChange,
    variant = "pill",
    icons = "always",
    children,
    className,
}: {
    defaultValue?: string;
    value?: string;
    onValueChange?: (v: string) => void;
    variant?: Variant;
    icons?: IconDisplay;
    children: ReactNode;
    className?: string;
}) {
    const [internal, setInternal] = useState(defaultValue ?? "");
    const layoutId = useId();
    const reduce = useReducedMotion();
    const controlled = value !== undefined;
    const current = controlled ? value : internal;
    const setValue = useCallback(
        (v: string) => {
            if (!controlled) setInternal(v);
            onValueChange?.(v);
        },
        [controlled, onValueChange],
    );
    const x = useSpring(0, transition);
    const y = useSpring(0, transition);
    const width = useSpring(0, transition);
    const height = useSpring(0, transition);
    const track = useMemo(() => ({ x, y, width, height }), [x, y, width, height]);
    const [placed, setPlaced] = useState(false);
    const [tabs, setTabs] = useState<Map<string, boolean>>(new Map());
    const registerTab = useCallback((tab: string, disabled: boolean) => {
        setTabs((map) => (map.get(tab) === disabled ? map : new Map(map).set(tab, disabled)));
    }, []);
    const unregisterTab = useCallback((tab: string) => {
        setTabs((map) => {
            if (!map.has(tab)) return map;
            const next = new Map(map);
            next.delete(tab);
            return next;
        });
    }, []);
    const [panels, setPanels] = useState<ReadonlySet<string>>(new Set());
    const registerPanel = useCallback((panel: string) => {
        setPanels((set) => (set.has(panel) ? set : new Set(set).add(panel)));
    }, []);
    const unregisterPanel = useCallback((panel: string) => {
        setPanels((set) => {
            if (!set.has(panel)) return set;
            const next = new Set(set);
            next.delete(panel);
            return next;
        });
    }, []);
    let tabStop: string | null = null;
    if (tabs.size > 0) {
        const enabled = Array.from(tabs).filter(([, disabled]) => !disabled);
        tabStop = enabled.some(([tab]) => tab === current) ? current : (enabled[0]?.[0] ?? "");
    }
    const baseId = useId();
    const tabId = useCallback(
        (tab: string) => `${baseId}-tab-${tab.replace(/[^\w-]/g, "_")}`,
        [baseId],
    );
    const panelId = useCallback(
        (tab: string) => `${baseId}-panel-${tab.replace(/[^\w-]/g, "_")}`,
        [baseId],
    );
    const contextValue = useMemo(
        () => ({
            value: current,
            setValue,
            layoutId,
            variant,
            icons,
            track,
            placed,
            setPlaced,
            tabStop,
            registerTab,
            unregisterTab,
            panels,
            registerPanel,
            unregisterPanel,
            tabId,
            panelId,
        }),
        [
            current,
            icons,
            layoutId,
            setValue,
            variant,
            track,
            placed,
            tabStop,
            registerTab,
            unregisterTab,
            panels,
            registerPanel,
            unregisterPanel,
            tabId,
            panelId,
        ],
    );
    return (
        <MotionConfig transition={reduce ? { duration: 0 } : transition}>
            <TabsCtx.Provider value={contextValue}>
                <motion.div layoutRoot className={className}>
                    {children}
                </motion.div>
            </TabsCtx.Provider>
        </MotionConfig>
    );
}
const listClasses: Record<Variant, string> = {
    pill: "inline-flex items-center gap-1 rounded-control bg-card p-1",
    underline: "inline-flex items-center gap-1 border-b border-border",
    segment: "inline-flex items-center gap-0 rounded-lg bg-card p-0.5",
};
export function TabsList({
    children,
    className,
    wrapperClassName,
    onKeyDown,
    ...props
}: {
    wrapperClassName?: string;
} & HTMLAttributes<HTMLDivElement>) {
    const { variant, value, icons, track, placed, setPlaced } = useTabs();
    const reduce = useReducedMotion();
    const tracked = icons === "selected" && variant !== "underline";
    const rootRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const viewportId = useId();
    const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
    const measure = useCallback(() => {
        const root = rootRef.current;
        const viewport = viewportRef.current;
        if (!root || !viewport) return;
        const overflow = viewport.scrollWidth > root.clientWidth + 1;
        const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const rtl = getComputedStyle(viewport).direction === "rtl";
        const fromLeft = Math.max(
            0,
            Math.min(max, rtl ? max + viewport.scrollLeft : viewport.scrollLeft),
        );
        const next = { overflow, left: fromLeft > 1, right: fromLeft < max - 1 };
        setEdges((previous) =>
            previous.overflow === next.overflow &&
            previous.left === next.left &&
            previous.right === next.right
                ? previous
                : next,
        );
    }, []);
    const reveal = useCallback(
        (tab: HTMLElement | null) => {
            const viewport = viewportRef.current;
            if (!viewport || !tab) return;
            const frame = viewport.getBoundingClientRect();
            const item = tab.getBoundingClientRect();
            const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
            const rtl = getComputedStyle(viewport).direction === "rtl";
            const fromLeft = Math.max(
                0,
                Math.min(max, rtl ? max + viewport.scrollLeft : viewport.scrollLeft),
            );
            const left = frame.left + (fromLeft > 1 ? 36 : 0);
            const right = frame.right - (fromLeft < max - 1 ? 36 : 0);
            const delta =
                item.left < left ? item.left - left : item.right > right ? item.right - right : 0;
            if (delta) viewport.scrollBy({ left: delta, behavior: reduce ? "instant" : "smooth" });
        },
        [reduce],
    );
    useLayoutEffect(() => {
        const root = rootRef.current;
        const viewport = viewportRef.current;
        const list = listRef.current;
        if (!root || !viewport || !list) return;
        const update = () => {
            measure();
            reveal(list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'));
        };
        const observer = new ResizeObserver(update);
        observer.observe(root);
        observer.observe(viewport);
        observer.observe(list);
        viewport.addEventListener("scroll", measure, { passive: true });
        update();
        return () => {
            observer.disconnect();
            viewport.removeEventListener("scroll", measure);
        };
    }, [measure, reveal]);
    useLayoutEffect(() => {
        void children;
        void value;
        void edges.overflow;
        measure();
        reveal(
            listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
                null,
        );
    }, [children, value, edges.overflow, measure, reveal]);
    useLayoutEffect(() => {
        if (!tracked) return;
        const list = listRef.current;
        if (!list) return;
        void children;
        const place = () => {
            const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
            const target = tabs.find((tab) => tab.dataset.tabsValue === value)?.parentElement;
            if (!target) return;
            const icons = Array.from(
                list.querySelectorAll<HTMLElement>('[role="tab"] > [data-tabs-icon]'),
            );
            const saved = icons.map((icon) => [icon.style.width, icon.style.marginRight]);
            for (const icon of icons) {
                const open = icon.parentElement?.parentElement === target;
                icon.style.width = open ? "auto" : "0px";
                icon.style.marginRight = open ? `${ICON_GAP}px` : "0px";
            }
            const box = {
                x: target.offsetLeft,
                y: target.offsetTop,
                width: target.getBoundingClientRect().width,
                height: target.offsetHeight,
            };
            icons.forEach((icon, index) => {
                [icon.style.width, icon.style.marginRight] = saved[index];
            });
            const instant = reduce || track.width.get() === 0;
            for (const key of ["x", "y", "width", "height"] as const) {
                if (instant) track[key].jump(box[key]);
                else track[key].set(box[key]);
            }
            if (box.width > 0) setPlaced(true);
        };
        place();
        const observer = new ResizeObserver(place);
        for (const tab of list.querySelectorAll('[role="tab"]'))
            if (tab.parentElement) observer.observe(tab.parentElement);
        return () => observer.disconnect();
    }, [tracked, value, children, reduce, track, setPlaced]);
    useLayoutEffect(() => {
        if (variant === "underline") return;
        const list = listRef.current;
        if (!list) return;
        void children;
        void placed;
        const labels = Array.from(list.querySelectorAll<HTMLElement>("[data-tabs-label]"));
        const indicator = list.querySelector<HTMLElement>("[data-tabs-indicator]");
        const target = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        if (!indicator || !target || target.dataset.tabsValue !== value) {
            for (const label of labels) label.style.clipPath = "inset(0 100% 0 0)";
            return;
        }
        let frames = 0;
        let stillFrames = 0;
        let previous:
            | {
                  left: number;
                  right: number;
              }
            | undefined;
        const syncClips = () => {
            const pill = (reduce ? target : indicator).getBoundingClientRect();
            const clips = labels.map((label) => {
                const bounds = label.getBoundingClientRect();
                const left = Math.max(0, Math.min(bounds.width, pill.left - bounds.left));
                const right = Math.max(0, Math.min(bounds.width, bounds.right - pill.right));
                return left + right >= bounds.width
                    ? "inset(0 100% 0 0)"
                    : `inset(0 ${right}px 0 ${left}px)`;
            });
            labels.forEach((label, index) => {
                if (label.style.clipPath !== clips[index]) label.style.clipPath = clips[index];
            });
            frames += 1;
            stillFrames =
                previous &&
                Math.abs(pill.left - previous.left) < 0.01 &&
                Math.abs(pill.right - previous.right) < 0.01
                    ? stillFrames + 1
                    : 0;
            previous = { left: pill.left, right: pill.right };
            if (reduce || (frames > 2 && stillFrames >= 2)) cancelFrame(syncClips);
        };
        frame.postRender(syncClips, true);
        const resync = () => {
            frames = 0;
            stillFrames = 0;
            previous = undefined;
            cancelFrame(syncClips);
            frame.postRender(syncClips, true);
        };
        const observer = new ResizeObserver(resync);
        observer.observe(list);
        return () => {
            observer.disconnect();
            cancelFrame(syncClips);
        };
    }, [value, children, variant, reduce, placed]);
    const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        const list = listRef.current;
        if (!list || !(event.target instanceof HTMLElement)) return;
        const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
            (tab) => !tab.disabled && tab.closest('[role="tablist"]') === list,
        );
        const at = tabs.indexOf(event.target as HTMLButtonElement);
        if (at < 0) return;
        const rtl = getComputedStyle(list).direction === "rtl";
        const forward = rtl ? "ArrowLeft" : "ArrowRight";
        const back = rtl ? "ArrowRight" : "ArrowLeft";
        const next =
            event.key === forward
                ? tabs[(at + 1) % tabs.length]
                : event.key === back
                  ? tabs[(at - 1 + tabs.length) % tabs.length]
                  : event.key === "Home"
                    ? tabs[0]
                    : event.key === "End"
                      ? tabs[tabs.length - 1]
                      : null;
        if (!next) return;
        event.preventDefault();
        next.focus();
        next.click();
    };
    const scroll = (direction: number) => {
        const viewport = viewportRef.current;
        if (viewport)
            viewport.scrollBy({
                left: direction * viewport.clientWidth * 0.8,
                behavior: reduce ? "instant" : "smooth",
            });
    };
    const controlClass =
        "absolute inset-y-0 z-20 inline-flex w-9 items-center justify-center text-foreground transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-0";
    const surfaceClass =
        variant === "pill"
            ? "rounded-control bg-card"
            : variant === "segment"
              ? "rounded-lg bg-card"
              : "";
    return (
        <div
            ref={rootRef}
            className={cn(
                "relative isolate flex w-full max-w-full min-w-0 items-center",
                edges.overflow && surfaceClass,
                wrapperClassName,
            )}
        >
            {edges.overflow && (
                <button
                    type="button"
                    aria-label="Scroll tabs left"
                    aria-controls={viewportId}
                    disabled={!edges.left}
                    onClick={() => scroll(-1)}
                    className={cn(controlClass, "left-0 rounded-l-full")}
                >
                    <ChevronLeft size={20} aria-hidden="true" />
                </button>
            )}
            <motion.div
                ref={viewportRef}
                id={viewportId}
                layoutScroll
                className={cn(
                    "w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                    edges.overflow && "[border-radius:inherit]",
                )}
                style={
                    edges.overflow
                        ? {
                              maskImage: `linear-gradient(to right, ${edges.left ? "transparent, black 40px" : "black, black 0px"}, ${edges.right ? "black calc(100% - 40px), transparent" : "black 100%"})`,
                          }
                        : undefined
                }
                onFocusCapture={(event) => {
                    if (
                        event.target instanceof HTMLElement &&
                        event.target.getAttribute("role") === "tab"
                    )
                        reveal(event.target);
                }}
            >
                <div
                    {...props}
                    ref={listRef}
                    role="tablist"
                    onKeyDown={onListKeyDown}
                    className={cn(listClasses[variant], "w-max", tracked && "relative", className)}
                >
                    {children}
                </div>
            </motion.div>
            {edges.overflow && edges.left && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 rounded-l-[inherit] backdrop-blur-[2px] [mask-image:linear-gradient(to_right,black,transparent)]"
                />
            )}
            {edges.overflow && edges.right && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 rounded-r-[inherit] backdrop-blur-[2px] [mask-image:linear-gradient(to_left,black,transparent)]"
                />
            )}
            {edges.overflow && (
                <button
                    type="button"
                    aria-label="Scroll tabs right"
                    aria-controls={viewportId}
                    disabled={!edges.right}
                    onClick={() => scroll(1)}
                    className={cn(controlClass, "right-0 rounded-r-full")}
                >
                    <ChevronRight size={20} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
const ICON_GAP = 6;
function TriggerIcon({
    icon,
    active,
}: {
    icon: ReactNode;
    active: boolean;
}) {
    const { icons } = useTabs();
    const reduce = useReducedMotion();
    if (icons === "always") {
        return (
            <span aria-hidden="true" className="mr-1.5 inline-flex shrink-0 items-center">
                {icon}
            </span>
        );
    }
    return (
        <motion.span
            aria-hidden="true"
            data-tabs-icon=""
            initial={false}
            animate={{
                width: active ? "auto" : 0,
                marginRight: active ? ICON_GAP : 0,
                opacity: active ? 1 : 0,
                scale: active ? 1 : 0.6,
            }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="inline-flex shrink-0 items-center justify-center overflow-hidden"
        >
            {icon}
        </motion.span>
    );
}
export function TabsTrigger({
    value,
    icon,
    children,
    className,
    indicatorClassName,
    onClick,
    ...props
}: {
    value: string;
    icon?: ReactNode;
    indicatorClassName?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value">) {
    const {
        value: current,
        setValue,
        layoutId,
        variant,
        icons,
        track,
        placed,
        tabStop,
        registerTab,
        unregisterTab,
        panels,
        tabId,
        panelId,
    } = useTabs();
    const active = current === value;
    const disabled = Boolean(props.disabled);
    useLayoutEffect(() => {
        registerTab(value, disabled);
    }, [registerTab, value, disabled]);
    useLayoutEffect(() => () => unregisterTab(value), [unregisterTab, value]);
    const a11y = {
        id: tabId(value),
        "aria-controls": panels.has(value) ? panelId(value) : undefined,
        tabIndex: !disabled && (tabStop === null || tabStop === value) ? 0 : -1,
    };
    const content = icon ? (
        <>
            <TriggerIcon icon={icon} active={active} />
            {children}
        </>
    ) : (
        children
    );
    const [initialClip] = useState(() => (active ? "inset(0)" : "inset(0 100% 0 0)"));
    if (variant === "underline") {
        return (
            <button
                {...a11y}
                {...props}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={(event) => {
                    onClick?.(event);
                    if (!event.defaultPrevented) setValue(value);
                }}
                className={cn(
                    "relative isolate px-3 pb-2.5 pt-1 -mb-px text-sm font-medium transition-colors min-h-[44px] inline-flex items-center whitespace-nowrap shrink-0",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    className,
                )}
            >
                {content}
                {active ? (
                    <motion.span
                        layoutId={layoutId}
                        layout
                        className={cn(
                            "absolute bottom-0 left-0 right-0 h-px bg-primary",
                            indicatorClassName,
                        )}
                    />
                ) : null}
            </button>
        );
    }
    const radius = variant === "pill" ? "rounded-control" : "rounded-md";
    const tracked = icons === "selected" && placed;
    return (
        <div className={cn("shrink-0", !tracked && "relative")}>
            {active && tracked ? (
                <motion.span
                    key="tracked"
                    data-tabs-indicator=""
                    style={{ ...track, borderRadius: variant === "pill" ? 9999 : 8 }}
                    className={cn("absolute top-0 left-0 bg-primary", radius, indicatorClassName)}
                />
            ) : active ? (
                <motion.span
                    key="layout"
                    data-tabs-indicator=""
                    layoutId={layoutId}
                    layout
                    style={{ borderRadius: variant === "pill" ? 9999 : 8 }}
                    className={cn("absolute inset-0 bg-primary", radius, indicatorClassName)}
                />
            ) : null}
            <button
                {...a11y}
                {...props}
                type="button"
                role="tab"
                aria-selected={active}
                data-tabs-value={value}
                onClick={(event) => {
                    onClick?.(event);
                    if (!event.defaultPrevented) setValue(value);
                }}
                className={cn(
                    "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none",
                    "text-muted-foreground hover:text-foreground",
                    radius,
                    className,
                )}
            >
                {content}
                <span
                    data-tabs-label=""
                    aria-hidden="true"
                    inert
                    className="pointer-events-none absolute inset-0 inline-flex items-center justify-center text-primary-foreground [gap:inherit] [padding:inherit]"
                    style={{ clipPath: initialClip }}
                >
                    {content}
                </span>
            </button>
        </div>
    );
}
export function TabsContent({
    value,
    children,
    className,
}: {
    value: string;
    children: ReactNode;
    className?: string;
}) {
    const { value: current, registerPanel, unregisterPanel, tabId, panelId } = useTabs();
    const reduce = useReducedMotion();
    const active = current === value;
    useLayoutEffect(() => {
        registerPanel(value);
        return () => unregisterPanel(value);
    }, [registerPanel, unregisterPanel, value]);
    const a11y = {
        id: panelId(value),
        role: "tabpanel",
        "aria-labelledby": tabId(value),
    } as const;
    if (!active) {
        return (
            <div {...a11y} hidden className={className}>
                {children}
            </div>
        );
    }
    return (
        <motion.div
            {...a11y}
            tabIndex={0}
            key={value}
            initial={{ opacity: 0, y: reduce ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className={cn(
                "mt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md",
                className,
            )}
        >
            {children}
        </motion.div>
    );
}
