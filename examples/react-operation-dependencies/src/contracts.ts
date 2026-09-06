import {
  dependencySignatureFromOperation,
  operationSignature,
  prepareInterface,
  type OBInterface,
} from "@openbindings/sdk";

export type Task = { id: string; title: string };
export type CreateTaskInput = { title: string };
export type Activity = { sequence: number; message: string };

const taskSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
  },
  required: ["id", "title"],
} as const;

export const TASK_REQUIREMENTS: OBInterface = {
  openbindings: "0.2.0",
  name: "Example task UI requirements",
  operations: {
    "example.tasks.list": {
      output: { type: "array", items: taskSchema },
    },
    "example.tasks.create": {
      input: {
        type: "object",
        properties: { title: { type: "string", minLength: 1 } },
        required: ["title"],
      },
      output: taskSchema,
    },
    "example.activity.watch": {
      output: {
        type: "object",
        properties: {
          sequence: { type: "integer" },
          message: { type: "string" },
        },
        required: ["sequence", "message"],
      },
    },
  },
  dependencies: {
    tasksList: { operation: "example.tasks.list" },
    tasksCreate: { operation: "example.tasks.create" },
    activityWatch: { operation: "example.activity.watch" },
  },
};

export const TASK_CONSUMER = await prepareInterface(TASK_REQUIREMENTS);

export const listTasksDependency = dependencySignatureFromOperation(
  "tasksList",
  operationSignature<never, Task[]>("example.tasks.list"),
);

export const createTaskDependency = dependencySignatureFromOperation(
  "tasksCreate",
  operationSignature<CreateTaskInput, Task>("example.tasks.create"),
);

export const watchActivityDependency = dependencySignatureFromOperation(
  "activityWatch",
  operationSignature<never, Activity>("example.activity.watch"),
);
