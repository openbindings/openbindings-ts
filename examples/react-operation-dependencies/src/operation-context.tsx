import {
  resolveOperationRequirement,
  type Invocation,
  type InvokeOptions,
  type OperationImplementation,
  type OperationMatch,
  type OperationRequirement,
  type OperationRequirementResolution,
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

type Available<I, O> = {
  status: "available";
  match: OperationMatch<I, O>;
  invoke(options?: InvokeOptions): Invocation<I, O>;
};

export type ReactiveOperationState<I, O> =
  | { status: "resolving" }
  | Available<I, O>
  | Extract<OperationRequirementResolution<I, O>, { status: "ambiguous" }>
  | Extract<OperationRequirementResolution<I, O>, { status: "unavailable" }>
  | { status: "failed"; error: Error };

const OperationImplementationsContext =
  createContext<readonly OperationImplementation[] | null>(null);

export function OperationProvider({
  implementations,
  children,
}: {
  implementations: readonly OperationImplementation[];
  children: ReactNode;
}) {
  return (
    <OperationImplementationsContext.Provider value={implementations}>
      {children}
    </OperationImplementationsContext.Provider>
  );
}

export function useOperation<I, O>(
  requirement: OperationRequirement<I, O>,
): ReactiveOperationState<I, O> {
  const implementations = useContext(OperationImplementationsContext);
  if (implementations === null) {
    throw new Error("useOperation must be rendered under OperationProvider");
  }

  const [resolution, setResolution] =
    useState<OperationRequirementResolution<I, O> | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const activeInvocations = useRef(new Set<Invocation<I, O>>());
  const resolutionRef =
    useRef<OperationRequirementResolution<I, O> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setResolution(null);
    resolutionRef.current = null;
    setFailure(null);

    void resolveOperationRequirement(requirement, implementations, {
      signal: controller.signal,
    }).then(
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
      controller.abort(new DOMException("operation candidates changed", "AbortError"));
    };
  }, [implementations, requirement]);

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
    const invocation = current.match.invoke(options);
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
