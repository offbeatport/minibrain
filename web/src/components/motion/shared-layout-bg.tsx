"use client";
import { SPRING_LAYOUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import {
    AnimatePresence,
    type HTMLMotionProps,
    type Variants,
    motion,
    useReducedMotion,
} from "motion/react";
import {
    Children,
    type FocusEvent,
    type HTMLAttributes,
    type MouseEvent,
    type ReactElement,
    type ReactNode,
    type Ref,
    cloneElement,
    forwardRef,
    isValidElement,
    useId,
    useRef,
    useState,
} from "react";
export interface SharedLayoutBgProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
    children: ReactNode;
    as?: "div" | "ul";
    pillClassName?: string;
    inset?: number;
    pillContainerClassName?: string;
}
const variants: Variants = {
    initial: { opacity: 0, filter: "blur(6px)" },
    animate: { opacity: 1, filter: "blur(0px)" },
    exit: (isActive: boolean) => (!isActive ? { opacity: 0, filter: "blur(6px)" } : {}),
};
const reducedVariants: Variants = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: (isActive: boolean) => (!isActive ? { opacity: 0 } : {}),
};
export const SharedLayoutBg = forwardRef<HTMLElement, SharedLayoutBgProps>(function SharedLayoutBg(
    {
        children,
        as = "div",
        className,
        onMouseLeave,
        onBlur,
        pillClassName,
        pillContainerClassName,
        inset = 20,
        ...props
    },
    forwardedRef,
) {
    const [activeId, setActiveId] = useState<string | null>(null);
    const uid = useId();
    const reduce = useReducedMotion();
    const hovering = useRef(false);
    const renderedChildren = Children.toArray(children)
        .filter(isValidElement)
        .map((child, index) => {
            const el = child as ReactElement<{
                className?: string;
                onMouseEnter?: () => void;
                onFocus?: (event: FocusEvent<HTMLElement>) => void;
                children?: ReactNode;
            }>;
            const childKey = el.key ? String(el.key) : `item-${index}`;
            return cloneElement(
                el,
                {
                    key: childKey,
                    className: cn("relative", el.props.className),
                    onMouseEnter: () => {
                        el.props.onMouseEnter?.();
                        hovering.current = true;
                        setActiveId(childKey);
                    },
                    onFocus: (event: FocusEvent<HTMLElement>) => {
                        el.props.onFocus?.(event);
                        setActiveId(childKey);
                    },
                },
                <>
                    <AnimatePresence custom={activeId !== null}>
                        {activeId !== null ? (
                            <motion.div
                                variants={reduce ? reducedVariants : variants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                custom={activeId !== null}
                                className={cn(
                                    "pointer-events-none absolute inset-y-0",
                                    pillContainerClassName,
                                )}
                                style={{ left: -inset, right: -inset }}
                            >
                                {activeId === childKey ? (
                                    <motion.div
                                        layoutId={`shared-bg-${uid}`}
                                        transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                                        className={cn(
                                            "pointer-events-none h-full w-full rounded-2xl bg-muted/80",
                                            pillClassName,
                                        )}
                                    />
                                ) : null}
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                    <div className="relative z-10">{el.props.children}</div>
                </>,
            );
        });
    const handleMouseLeave = (event: MouseEvent<HTMLElement>) => {
        hovering.current = false;
        if (!event.currentTarget.contains(document.activeElement)) setActiveId(null);
        onMouseLeave?.(event);
    };
    const handleBlur = (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        if (!hovering.current && !(next instanceof Node && event.currentTarget.contains(next)))
            setActiveId(null);
        onBlur?.(event);
    };
    return as === "ul" ? (
        <motion.ul
            {...(props as HTMLMotionProps<"ul">)}
            ref={forwardedRef as Ref<HTMLUListElement>}
            layoutRoot
            onMouseLeave={handleMouseLeave}
            onBlur={handleBlur}
            className={cn("flex w-full flex-col", className)}
        >
            {renderedChildren}
        </motion.ul>
    ) : (
        <motion.div
            {...(props as HTMLMotionProps<"div">)}
            ref={forwardedRef as Ref<HTMLDivElement>}
            layoutRoot
            onMouseLeave={handleMouseLeave}
            onBlur={handleBlur}
            className={cn("flex w-full flex-col", className)}
        >
            {renderedChildren}
        </motion.div>
    );
});
