import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, clearSignOutReason, onSignedOut, setCsrfToken, succeed, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type SessionInfo = Schemas["SessionInfo"];
export type PersonInfo = Schemas["PersonInfo"];
export type AccountInfo = Schemas["AccountInfo"];
export type PasswordLink = Schemas["PasswordLink"];
export type Role = NonNullable<PersonInfo["role"]>;

export const authKeys = {
    session: ["auth", "session"] as const,
    accounts: ["accounts"] as const,
};

async function loadSession(): Promise<SessionInfo> {
    const info = await unwrap(api.GET("/api/auth/session"));
    setCsrfToken(info.csrf_token ?? null);
    return info;
}

export function useSession() {
    const client = useQueryClient();
    useEffect(
        () =>
            onSignedOut(() => {
                void client.invalidateQueries({ queryKey: authKeys.session });
            }),
        [client],
    );
    return useQuery({ queryKey: authKeys.session, queryFn: loadSession, staleTime: 60_000 });
}

export function usePerson(): PersonInfo | null {
    return useSession().data?.person ?? null;
}

function useSignedIn() {
    const client = useQueryClient();
    return async (info: SessionInfo) => {
        clearSignOutReason();
        setCsrfToken(info.csrf_token ?? null);
        client.setQueryData(authKeys.session, info);
        await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
    };
}

export function useSignIn() {
    const signedIn = useSignedIn();
    return useMutation({
        mutationFn: (body: Schemas["SignInBody"]) => unwrap(api.POST("/api/auth/login", { body })),
        onSuccess: signedIn,
    });
}

export function useSetup() {
    const signedIn = useSignedIn();
    return useMutation({
        mutationFn: (body: Schemas["SetupBody"]) => unwrap(api.POST("/api/auth/setup", { body })),
        onSuccess: signedIn,
    });
}

export function useSetPassword() {
    const signedIn = useSignedIn();
    return useMutation({
        mutationFn: (body: Schemas["ResetBody"]) => unwrap(api.POST("/api/auth/reset", { body })),
        onSuccess: signedIn,
    });
}

export function useSignOut() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => succeed(api.POST("/api/auth/logout")),
        onSettled: async () => {
            setCsrfToken(null);
            client.setQueryData(authKeys.session, await loadSession());
            client.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
        },
    });
}

export function useAccounts(enabled: boolean) {
    return useQuery({
        queryKey: authKeys.accounts,
        queryFn: () => unwrap(api.GET("/api/accounts")),
        enabled,
    });
}
