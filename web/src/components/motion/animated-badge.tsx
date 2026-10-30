"use client";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, Circle, Info, LoaderCircle, type LucideIcon, X } from "lucide-react";
import {
    AnimatePresence,
    type HTMLMotionProps,
    type Variants,
    motion,
    useReducedMotion,
} from "motion/react";
import type { ReactNode } from "react";
export type AnimatedBadgeStatus = "neutral" | "info" | "success" | "warning" | "danger" | "loading";
export type AnimatedBadgeSize = "sm" | "md";
export interface AnimatedBadgeProps extends Omit<HTMLMotionProps<"span">, "children"> {
    status?: AnimatedBadgeStatus;
    size?: AnimatedBadgeSize;
    children?: ReactNode;
    icon?: ReactNode;
    showIcon?: boolean;
    pulse?: boolean;
    contentKey?: string | number;
}
const STATUS_CLASS: Record<AnimatedBadgeStatus, string> = {
    neutral: "border-border bg-card text-muted-foreground",
    info: "border-primary/30 bg-muted text-primary",
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    danger: "border-destructive/30 bg-destructive/10 text-destructive",
    loading: "border-primary/30 bg-muted text-primary",
};
const SIZE_CLASS: Record<AnimatedBadgeSize, string> = {
    sm: "h-6 gap-1.5 px-2 text-[11px]",
    md: "h-8 gap-2 px-3 text-xs",
};
const ICON_CLASS: Record<AnimatedBadgeSize, string> = {
    sm: "h-3 w-3",
    md: "h-3.5 w-3.5",
};
const ICONS: Record<AnimatedBadgeStatus, LucideIcon> = {
    neutral: Circle,
    info: Info,
    success: Check,
    warning: AlertTriangle,
    danger: X,
    loading: LoaderCircle,
};
const ROLL_EXIT_TRANSITION = { duration: 0.14, ease: EASE_OUT } as const;
const ROLL_BLUR = "blur(3px)";
const ICON_ROLL_VARIANTS: Variants = {
    initial: { opacity: 0, y: 12, filter: ROLL_BLUR },
    animate: {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        transition: SPRING_SWAP,
    },
    exit: {
        opacity: 0,
        y: -12,
        filter: ROLL_BLUR,
        transition: ROLL_EXIT_TRANSITION,
    },
};
const TEXT_ROLL_VARIANTS: Variants = {
    initial: { opacity: 0, y: "90%", filter: ROLL_BLUR },
    animate: {
        opacity: 1,
        y: "0%",
        filter: "blur(0px)",
        transition: SPRING_SWAP,
    },
    exit: {
        opacity: 0,
        y: "-90%",
        filter: ROLL_BLUR,
        transition: ROLL_EXIT_TRANSITION,
    },
};
const REST = { opacity: 1, y: 0, filter: "blur(0px)" } as const;
const REST_EXIT = { opacity: 0, transition: { duration: 0 } } as const;
export function AnimatedBadge({
    status = "neutral",
    size = "md",
    children,
    icon,
    showIcon = true,
    pulse = status === "loading",
    contentKey,
    className,
    style,
    ...rest
}: AnimatedBadgeProps) {
    const reduce = useReducedMotion();
    const slotLayout = reduce ? false : ("position" as const);
    const Icon = ICONS[status];
    const hasLabel = children != null && typeof children !== "boolean" && children !== "";
    const resolvedContentKey =
        contentKey ??
        (typeof children === "string" || typeof children === "number" ? children : status);
    return (
        <motion.span
            layout={!reduce}
            transition={SPRING_LAYOUT}
            style={style}
            className={cn(
                "relative inline-flex shrink-0 items-center overflow-hidden whitespace-nowrap rounded-badge border font-medium tabular-nums",
                "transition-colors duration-300",
                STATUS_CLASS[status],
                SIZE_CLASS[size],
                className,
            )}
            {...rest}
        >
            {pulse && !reduce ? (
                <motion.span
                    aria-hidden
                    className="absolute inset-0 rounded-badge bg-current"
                    initial={{ opacity: 0.06 }}
                    animate={{ opacity: [0.06, 0.18, 0.06] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                />
            ) : null}

            {showIcon ? (
                <motion.span
                    layout={slotLayout}
                    transition={SPRING_LAYOUT}
                    className="relative z-10 inline-grid shrink-0 place-items-center overflow-hidden"
                >
                    <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span
                            key={status}
                            aria-hidden
                            data-badge-icon
                            variants={ICON_ROLL_VARIANTS}
                            initial={reduce ? false : "initial"}
                            animate={reduce ? REST : "animate"}
                            exit={reduce ? REST_EXIT : "exit"}
                            className="col-start-1 row-start-1 inline-flex items-center justify-center"
                        >
                            {status === "loading" && !reduce && !icon ? (
                                <motion.span
                                    animate={{ rotate: 360 }}
                                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                                    className="inline-flex"
                                >
                                    <Icon className={ICON_CLASS[size]} />
                                </motion.span>
                            ) : (
                                (icon ?? <Icon className={ICON_CLASS[size]} />)
                            )}
                        </motion.span>
                    </AnimatePresence>
                </motion.span>
            ) : null}
            {hasLabel ? (
                <motion.span
                    layout={slotLayout}
                    transition={SPRING_LAYOUT}
                    className="relative z-10 inline-flex"
                    style={{ clipPath: "inset(0 -999px)" }}
                >
                    <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span
                            key={resolvedContentKey}
                            data-badge-label
                            variants={TEXT_ROLL_VARIANTS}
                            initial={reduce ? false : "initial"}
                            animate={reduce ? REST : "animate"}
                            exit={reduce ? REST_EXIT : "exit"}
                            className="inline-block"
                        >
                            {children}
                        </motion.span>
                    </AnimatePresence>
                </motion.span>
            ) : null}
        </motion.span>
    );
}
