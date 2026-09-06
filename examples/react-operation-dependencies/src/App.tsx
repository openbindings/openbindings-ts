import {
  single,
  type PreparedProvider,
  type ProviderRegistration,
} from "@openbindings/sdk";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createTaskDependency,
  listTasksDependency,
  watchActivityDependency,
  type Activity,
  type Task,
} from "./contracts.js";
import {
  activityImplementation,
  slowImplementation,
  tasksImplementation,
} from "./implementations.js";
import {
  OperationProvider,
  useOperation,
  type ReactiveOperationState,
} from "./operation-context.js";

type CandidateMode = "primary" | "none" | "ambiguous" | "preferred" | "slow";

function Status({
  value,
}: {
  value: ReactiveOperationState<unknown, unknown>["status"];
}) {
  return <span className={`status status-${value}`}>{value}</span>;
}

function Dashboard() {
  const list = useOperation(listTasksDependency);
  const create = useOperation(createTaskDependency);
  const activity = useOperation(watchActivityDependency);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("Ready");
  const [events, setEvents] = useState<Activity[]>([]);

  async function refresh() {
    if (list.status !== "available") return;
    setMessage("Loading tasks");
    try {
      const invocation = list.invoke();
      setTasks(await single(invocation.outputs));
      setMessage("Tasks loaded");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (create.status !== "available" || !title.trim()) return;
    setMessage("Creating task");
    try {
      const invocation = create.invoke();
      await invocation.write({ title: title.trim() });
      const task = await single(invocation.outputs);
      setTasks(current => [...current, task]);
      setTitle("");
      setMessage(`Created ${task.id}`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function watch() {
    if (activity.status !== "available") return;
    setEvents([]);
    const invocation = activity.invoke();
    try {
      for await (const item of invocation.outputs) {
        setEvents(current => [...current, item]);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="dashboard" data-testid="dashboard">
      <section className="hero">
        <div>
          <p className="eyebrow">React lifecycle proof</p>
          <h1>Components require operations, not protocols.</h1>
          <p>
            This component knows task and activity contracts. The application
            supplies OpenAPI and local implementations.
          </p>
        </div>
        <div className="state-grid">
          <div><span>List</span><Status value={list.status} /></div>
          <div><span>Create</span><Status value={create.status} /></div>
          <div><span>Activity</span><Status value={activity.status} /></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Required capability</p>
            <h2>Tasks</h2>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={list.status !== "available"}
          >
            Refresh
          </button>
        </div>

        {list.status === "ambiguous" && (
          <p className="notice" data-testid="ambiguity">
            The application must resolve the {list.ambiguity.stage} tie between {list.ambiguity.providers.length} equally
            preferred task implementations.
          </p>
        )}
        {list.status === "unavailable" && (
          <p className="notice" data-testid="unavailable">
            No compatible, invocable task implementation is currently supplied.
          </p>
        )}

        <ul className="tasks" data-testid="tasks">
          {tasks.map(task => (
            <li key={task.id}>
              <span>{task.title}</span>
              <code>{task.id}</code>
            </li>
          ))}
        </ul>

        <form onSubmit={event => void submit(event)}>
          <label htmlFor="task-title">New task</label>
          <div className="form-row">
            <input
              id="task-title"
              value={title}
              onChange={event => setTitle(event.currentTarget.value)}
              placeholder="What needs doing?"
            />
            <button
              type="submit"
              disabled={create.status !== "available" || !title.trim()}
            >
              Create
            </button>
          </div>
        </form>
        <p className="message" role="status">{message}</p>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Streaming capability</p>
            <h2>Activity</h2>
          </div>
          <button
            type="button"
            onClick={() => void watch()}
            disabled={activity.status !== "available"}
          >
            Start stream
          </button>
        </div>
        <ol className="events" data-testid="events">
          {events.map(event => (
            <li key={event.sequence}>{event.message}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}

export default function App() {
  const [catalog, setCatalog] = useState<{
    primary: PreparedProvider;
    mirror: PreparedProvider;
    activity: PreparedProvider;
    slow: PreparedProvider;
  } | null>(null);
  const [mode, setMode] = useState<CandidateMode>("primary");
  const [mounted, setMounted] = useState(true);
  const [cancelledStreams, setCancelledStreams] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let owned: PreparedProvider[] | undefined;
    void Promise.all([
      tasksImplementation("primary-api"),
      tasksImplementation("mirror-api"),
      activityImplementation(() => setCancelledStreams(count => count + 1)),
      slowImplementation(),
    ]).then(providers => {
      owned = providers;
      if (controller.signal.aborted) {
        void Promise.all(providers.map(provider => provider.dispose()));
        return;
      }
      setCatalog({
        primary: providers[0],
        mirror: providers[1],
        activity: providers[2],
        slow: providers[3],
      });
    });
    return () => {
      controller.abort();
      if (owned) void Promise.all(owned.map(provider => provider.dispose()));
    };
  }, []);

  useEffect(() => {
    if (mode !== "slow") return;
    const timer = setTimeout(() => setMode("none"), 35);
    return () => clearTimeout(timer);
  }, [mode]);

  const providers = useMemo(() => {
    if (!catalog) return [];
    const taskProviders: ProviderRegistration[] = [];
    if (mode === "slow") taskProviders.push({ provider: catalog.slow });
    else if (mode !== "none") {
      taskProviders.push({
        provider: catalog.primary,
        preference: mode === "preferred" ? 10 : 0,
      });
      if (mode === "ambiguous" || mode === "preferred") {
        taskProviders.push({ provider: catalog.mirror, preference: 0 });
      }
    }
    return [...taskProviders, { provider: catalog.activity }];
  }, [catalog, mode]);

  return (
    <OperationProvider providers={providers}>
      <header className="controls">
        <strong>Application composition</strong>
        <div>
          <button type="button" onClick={() => setMode("primary")}>Primary</button>
          <button type="button" onClick={() => setMode("none")}>Remove API</button>
          <button type="button" onClick={() => setMode("ambiguous")}>Add equal mirror</button>
          <button type="button" onClick={() => setMode("preferred")}>Prefer primary</button>
          <button type="button" onClick={() => setMode("slow")}>Race replacement</button>
          <button type="button" onClick={() => setMounted(value => !value)}>
            {mounted ? "Unmount UI" : "Mount UI"}
          </button>
        </div>
        <span data-testid="cancelled-streams">
          Cancelled streams: {cancelledStreams}
        </span>
      </header>
      {mounted ? <Dashboard /> : (
        <p className="unmounted" data-testid="unmounted">Dashboard unmounted</p>
      )}
    </OperationProvider>
  );
}
