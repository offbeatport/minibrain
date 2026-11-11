import { useRouterState } from "@tanstack/react-router";
import { TabNav, type TabNavItem } from "obp-ui";
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { OVERVIEW_PATH, REQUESTS_PATH } from "~/lib/requests";
import { OverviewTab } from "./monitor/OverviewTab";
import { LiveControl, RequestsTab } from "./monitor/RequestsTab";

const TABS: TabNavItem[] = [
    { label: "Overview", href: OVERVIEW_PATH },
    { label: "Requests", href: REQUESTS_PATH },
];

const CAPTIONS: Record<string, string> = {
    [OVERVIEW_PATH]: "Traffic on the /v1 API by model: request rate, errors, latency and tokens.",
    [REQUESTS_PATH]: "Calls to the /v1 API as they arrive: model, key, status, latency and tokens.",
};

function tabOf(pathname: string): string {
    const trimmed = pathname.replace(/\/+$/, "") || OVERVIEW_PATH;
    return trimmed in CAPTIONS ? trimmed : OVERVIEW_PATH;
}

export function MonitorPage() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const tab = tabOf(pathname);
    const [paused, setPaused] = useState(false);
    return (
        <Page wide>
            <PageHeader
                title="Monitoring"
                caption={CAPTIONS[tab]}
                actions={
                    <LiveControl paused={paused} onToggle={() => setPaused((value) => !value)} />
                }
            />
            <TabNav label="Monitoring pages" tabs={TABS} />
            {tab === OVERVIEW_PATH && <OverviewTab paused={paused} />}
            {tab === REQUESTS_PATH && <RequestsTab paused={paused} />}
        </Page>
    );
}
