
"use client";

import {
    useCallback,
    useEffect,
    useSyncExternalStore,
} from "react";

export function useOnlineStatus(
    onReconnect?: () => void | Promise<void>
) {
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            window.addEventListener("online", onStoreChange);
            window.addEventListener("offline", onStoreChange);

            return () => {
                window.removeEventListener("online", onStoreChange);
                window.removeEventListener("offline", onStoreChange);
            };
        },
        []
    );

    const getSnapshot = useCallback(
        () => navigator.onLine,
        []
    );

    const getServerSnapshot = useCallback(
        () => true,
        []
    );

    const isOnline = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot
    );

    useEffect(() => {
        function handleOnline() {
            if (onReconnect) {
                void onReconnect();
            }
        }

        window.addEventListener("online", handleOnline);

        return () => {
            window.removeEventListener("online", handleOnline);
        };
    }, [onReconnect]);

    return isOnline;
}
