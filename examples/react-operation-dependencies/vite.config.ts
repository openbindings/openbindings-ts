import { defineConfig, type Connect, type Plugin } from "vite";

type Task = { id: string; title: string };

function tasksAPI(): Plugin {
  const tasks: Task[] = [{ id: "task_1", title: "Prove the browser path" }];
  let nextID = 2;

  const install = (middlewares: Connect.Server) => {
    middlewares.use("/api/tasks", (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify(tasks));
        return;
      }
      if (request.method === "POST") {
        const chunks: string[] = [];
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => chunks.push(chunk));
        request.on("end", () => {
          const input = JSON.parse(chunks.join("")) as {
            title: string;
          };
          const task = { id: `task_${nextID++}`, title: input.title };
          tasks.push(task);
          response.statusCode = 201;
          response.end(JSON.stringify(task));
        });
        return;
      }
      response.statusCode = 405;
      response.end(JSON.stringify({ error: "method not allowed" }));
    });
  };

  return {
    name: "openbindings-example-tasks-api",
    configureServer: server => install(server.middlewares),
    configurePreviewServer: server => install(server.middlewares),
  };
}

export default defineConfig({
  plugins: [tasksAPI()],
  build: {
    target: "es2022",
  },
});
