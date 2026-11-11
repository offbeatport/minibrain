import { type RouteComponent, useParams, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

type Params = Record<string, string | undefined>;

export function Redirect({ to }: { to: string }) {
    const router = useRouter();
    useEffect(() => {
        router.history.replace(to);
    }, [router, to]);
    return null;
}

export function redirectTo(target: (params: Params) => string): RouteComponent {
    return function RedirectRoute() {
        const params = useParams({ strict: false }) as Params;
        return <Redirect to={target(params)} />;
    };
}
