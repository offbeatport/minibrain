import { MotionGlobalConfig } from "motion/react";

export const ANIMATION = {
    cssTransitions: false,
    hoverScale: false,
    springs: false,
};

export function applyAnimationSettings(root: HTMLElement): void {
    MotionGlobalConfig.instantAnimations = !ANIMATION.springs;
    root.classList.toggle("no-transitions", !ANIMATION.cssTransitions);
    root.classList.toggle("no-springs", !ANIMATION.springs);
}
