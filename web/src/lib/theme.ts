import { applyPresetStyle, getTheme, initTheme, onThemeChange, themePresetFor } from "obp-ui";

const PRESET = "cobalt";

function applyPreset(): void {
    applyPresetStyle(themePresetFor(PRESET) ?? null, getTheme());
}

export function initAppTheme(): void {
    initTheme();
    applyPreset();
    onThemeChange(applyPreset);
}
