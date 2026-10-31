import { useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger } from "obp-ui";

export function SettingsTabs({ active }: { active: "/settings" | "/settings/security" }) {
    const navigate = useNavigate();
    return (
        <Tabs
            value={active}
            onValueChange={(value) =>
                navigate({
                    to: value === "/settings/security" ? "/settings/security" : "/settings",
                })
            }
        >
            <TabsList variant="line">
                <TabsTrigger value="/settings">General</TabsTrigger>
                <TabsTrigger value="/settings/security">Security</TabsTrigger>
            </TabsList>
        </Tabs>
    );
}
