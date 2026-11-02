import { getTheme, initTheme, onThemeChange, themePresetFor, themePresetStyle } from "obp-ui";

const PRESET = "cobalt";

function applyPreset(): void {
    const preset = themePresetFor(PRESET);
    if (!preset) {
        return;
    }
    const root = document.documentElement;
    for (const [name, value] of Object.entries(themePresetStyle(preset, getTheme()))) {
        root.style.setProperty(name, value);
    }
}

export function initAppTheme(): void {
    initTheme();
    applyPreset();
    onThemeChange(applyPreset);
}
