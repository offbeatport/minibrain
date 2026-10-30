import { initTheme, onThemeChange, themePresetFor, themePresetStyle } from "obp-ui";

const PRESET_ID = "paper";

function applyPreset(): void {
    const preset = themePresetFor(PRESET_ID);
    if (!preset) {
        return;
    }
    const root = document.documentElement;
    const mode = root.classList.contains("dark") ? "dark" : "light";
    for (const [name, value] of Object.entries(themePresetStyle(preset, mode))) {
        root.style.setProperty(name, value);
    }
}

export function initAppTheme(): void {
    initTheme();
    applyPreset();
    onThemeChange(applyPreset);
}
