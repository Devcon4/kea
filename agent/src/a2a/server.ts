import { randomUUID } from "node:crypto";
import { Subject, BehaviorSubject, Observable } from "rxjs";
import { filter, map } from "rxjs/operators";
import { Ok, Err } from "../result.js";
import type { Result } from "../result.js";
import type {
  AgentCard,
  Message,
  Task,
  TaskState,
  SendMessageRequest,
  SendMessageResponse,
  Part,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("a2a-server");

export type TaskHandlerResult = {
  state: TaskState;
  response: Part[];
  artifacts?: Task["artifacts"];
};

export type TaskHandler = (
  task: Task,
  message: Message,
) => Promise<Result<TaskHandlerResult, Error>>;

export type TaskEvent = {
  taskId: string;
  task: Task;
  message: Message;
  type: "created" | "working" | "completed" | "failed" | "canceled";
};

export class A2AServer {
  public readonly card: AgentCard;
  private handler: TaskHandler;

  private tasks$ = new BehaviorSubject<ReadonlyMap<string, Task>>(new Map());
  private events$ = new Subject<TaskEvent>();

  constructor(card: AgentCard, handler: TaskHandler) {
    this.card = card;
    this.handler = handler;
  }

  getAgentCard(): AgentCard {
    return this.card;
  }

  /** Observable stream of all task lifecycle events */
  get taskEvents$(): Observable<TaskEvent> {
    return this.events$.asObservable();
  }

  /** Observable of tasks filtered by state */
  tasksByState$(state: TaskState): Observable<Task> {
    return this.events$.pipe(
      filter((e) => e.task.status.state === state),
      map((e) => e.task),
    );
  }

  /** Current snapshot of all tasks */
  get tasksSnapshot(): ReadonlyMap<string, Task> {
    return this.tasks$.getValue();
  }

  async sendMessage(req: SendMessageRequest): Promise<Result<SendMessageResponse, Error>> {
    const { message } = req;
    const contextId = message.contextId ?? randomUUID();
    const taskId = message.taskId ?? randomUUID();

    const task = this.findOrCreateTask(taskId, contextId);

    task.history = task.history ?? [];
    task.history.push(message);
    this.updateTaskState(task, "TASK_STATE_WORKING", undefined, message, "working");

    log.info({ taskId, agent: this.card.name }, "processing message");

    const handlerResult = await this.handler(task, message);

    if (!handlerResult.ok) {
      const errorMsg = this.buildMessage(contextId, taskId, [
        { text: handlerResult.error.message },
      ]);
      task.history.push(errorMsg);
      this.updateTaskState(task, "TASK_STATE_FAILED", errorMsg, message, "failed");
      log.error({ taskId, error: handlerResult.error.message }, "task failed");
      return Ok({ task });
    }

    const { state, response, artifacts } = handlerResult.value;
    const responseMsg = this.buildMessage(contextId, taskId, response);

    task.history.push(responseMsg);

    if (artifacts) {
      task.artifacts = artifacts;
    }

    const eventType = TERMINAL_STATES.has(state) ? "completed" : "working";
    this.updateTaskState(task, state, responseMsg, message, eventType);

    log.info({ taskId, state }, "task updated");
    return Ok({ task });
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks$.getValue().get(taskId);
  }

  listTasks(contextId?: string): Task[] {
    const all = Array.from(this.tasks$.getValue().values());
    if (!contextId) return all;
    return all.filter((t) => t.contextId === contextId);
  }

  cancelTask(taskId: string): Result<Task, Error> {
    const task = this.tasks$.getValue().get(taskId);
    if (!task) return Err(new Error(`Task not found: ${taskId}`));
    if (TERMINAL_STATES.has(task.status.state)) {
      return Err(new Error(`Task ${taskId} already terminal: ${task.status.state}`));
    }

    this.updateTaskState(
      task,
      "TASK_STATE_CANCELED",
      undefined,
      { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "canceled" }] },
      "canceled",
    );
    return Ok(task);
  }

  dispose(): void {
    this.events$.complete();
    this.tasks$.complete();
  }

  private findOrCreateTask(taskId: string, contextId: string): Task {
    const existing = this.tasks$.getValue().get(taskId);
    if (existing) return existing;

    const task: Task = {
      id: taskId,
      contextId,
      status: {
        state: "TASK_STATE_SUBMITTED",
        timestamp: new Date().toISOString(),
      },
      history: [],
    };

    const next = new Map(this.tasks$.getValue());
    next.set(taskId, task);
    this.tasks$.next(next);

    this.events$.next({
      taskId,
      task,
      message: { messageId: randomUUID(), role: "ROLE_USER", parts: [] },
      type: "created",
    });

    return task;
  }

  private updateTaskState(
    task: Task,
    state: TaskState,
    statusMessage: Message | undefined,
    triggerMessage: Message,
    eventType: TaskEvent["type"],
  ): void {
    task.status = {
      state,
      message: statusMessage,
      timestamp: new Date().toISOString(),
    };

    const next = new Map(this.tasks$.getValue());
    next.set(task.id, task);
    this.tasks$.next(next);

    this.events$.next({
      taskId: task.id,
      task,
      message: triggerMessage,
      type: eventType,
    });
  }

  private buildMessage(contextId: string, taskId: string, parts: Part[]): Message {
    return {
      messageId: randomUUID(),
      contextId,
      taskId,
      role: "ROLE_AGENT",
      parts,
    };
  }
}
