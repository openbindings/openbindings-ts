import {
  CompositionSession,
  type DependencyRouteResolution,
  type DependencySignature,
  type Invocation,
  type InvokeOptions,
  type PreparedDependencyRoute,
  type ProviderRegistration,
} from "@openbindings/sdk";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TASK_CONSUMER } from "./contracts.js";

type Available<I, O> = {
  status: "available";
  route: PreparedDependencyRoute<I, O>;
  invoke(options?: InvokeOptions): Invocation<I, O>;
};

export type ReactiveOperationState<I, O> =
  | { status: "resolving" }
  | Available<I, O>
  | Extract<DependencyRouteResolution<I, O>, { status: "ambiguous" }>
  | Extract<DependencyRouteResolution<I, O>, { status: "unavailable" }>
  | { status: "failed"; error: Error };

const ProviderRegistrationsContext =
  createContext<readonly ProviderRegistration[] | null>(null);

export function OperationProvider({
  providers,
  children,
}: {
  providers: readonly ProviderRegistration[];
  children: ReactNode;
}) {
  return (
    <ProviderRegistrationsContext.Provider value={providers}>
      {children}
    </ProviderRegistrationsContext.Provider>
  );
}

export function useOperation<I, O>(
  dependency: DependencySignature<I, O>,
): ReactiveOperationState<I, O> {
  const providers = useContext(ProviderRegistrationsContext);
  if (providers === null) {
    throw new Error("useOperation must be rendered under OperationProvider");
  }

  const [resolution, setResolution] =
    useState<DependencyRouteResolution<I, O> | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const activeInvocations = useRef(new Set<Invocation<I, O>>());
  const resolutionRef =
    useRef<DependencyRouteResolution<I, O> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setResolution(null);
    resolutionRef.current = null;
    setFailure(null);

    const session = new CompositionSession({ consumer: TASK_CONSUMER, providers });
    void session.resolve(dependency, { signal: controller.signal }).then(
      next => {
        if (!current) return;
        resolutionRef.current = next;
        setResolution(next);
      },
      error => {
        if (!current || controller.signal.aborted) return;
        setFailure(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return () => {
      current = false;
      controller.abort(new DOMException("providers changed", "AbortError"));
      for (const invocation of activeInvocations.current) void invocation.cancel();
      activeInvocations.current.clear();
    };
  }, [dependency, providers]);

  useEffect(() => {
    const active = activeInvocations.current;
    return () => {
      for (const invocation of active) void invocation.cancel();
      active.clear();
    };
  }, []);

  const invoke = useCallback((options?: InvokeOptions): Invocation<I, O> => {
    const current = resolutionRef.current;
    if (current?.status !== "available") {
      throw new Error("operation is not available");
    }
    const invocation = current.route.invoke(options);
    activeInvocations.current.add(invocation);
    const forget = () => activeInvocations.current.delete(invocation);
    void invocation.closed.then(forget, forget);
    return invocation;
  }, []);

  if (failure) return { status: "failed", error: failure };
  if (!resolution) return { status: "resolving" };
  if (resolution.status === "available") {
    return { ...resolution, invoke };
  }
  return resolution;
}
