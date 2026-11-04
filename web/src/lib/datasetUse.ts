function listed(names: string[]): string {
    if (names.length <= 1) {
        return names.join("");
    }
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function datasetDeleteNote(names: string[]): string {
    if (names.length === 0) {
        return "The query goes; the sources it reads stay.";
    }
    const plural = names.length > 1;
    return `Used by ${listed(names)}. ${plural ? "They keep their" : "It keeps its"} trained versions and the data they trained on, and ${plural ? "need" : "needs"} a new dataset before ${plural ? "they train" : "it trains"} again. The sources it reads stay.`;
}
