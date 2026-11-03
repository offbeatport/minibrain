const STORAGE_KEY = "minibrain.lastAppPage";

let lastAppPage: string | null = null;

export function rememberAppPage(href: string): void {
    lastAppPage = href;
    try {
        window.sessionStorage.setItem(STORAGE_KEY, href);
    } catch {
        return;
    }
}

export function appPageToReturnTo(): string {
    if (lastAppPage) {
        return lastAppPage;
    }
    try {
        return window.sessionStorage.getItem(STORAGE_KEY) ?? "/";
    } catch {
        return "/";
    }
}
