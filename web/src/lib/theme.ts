import {
    applyPresetStyle,
    getTheme,
    initTheme,
    onThemeChange,
    themePresetFor,
    themePresetStyle,
} from "obp-ui";

const PRESET = "cobalt";

function applyPreset(): void {
    applyPresetStyle(themePresetFor(PRESET) ?? null, getTheme());
}

export function appPresetStyle(mode: "light" | "dark"): Record<string, string> {
    const preset = themePresetFor(PRESET);
    return preset ? themePresetStyle(preset, mode) : {};
}

export function initAppTheme(): void {
    initTheme();
    applyPreset();
    onThemeChange(applyPreset);
}
