import EventEmitter from './EventEmitter';
import {
  EVENT_INSTANCE_COMPLETE,
  EVENT_INSTANCE_INTERRUPTED,
  FlowStatus,
} from './constant/constant';
import { createTaskId } from './util/ID';
import type {
  ActionResult,
  TaskParam,
  NodeParam,
  ResumeParam,
} from './types.d';
import type FlowModel from './FlowModel';
import type { NextTaskParam } from './nodes/BaseNode';
import type Recorder from './recorder';

type TaskParamMap = Map<string, TaskParam>;

type TaskResult = {
  extraInfo?: Record<string, any>;
} & NextTaskParam;

/**
 * 调度器
 * 通过一个队列维护需要执行的节点，一个集合维护正在执行的节点
 */
export default class Scheduler extends EventEmitter {
  nodeQueueMap: Map<string, NodeParam[]>;
  taskRunningMap: Map<string, TaskParamMap>;
  flowModel: FlowModel;
  recorder: Recorder;
  currentTask: TaskParam | null;
  constructor(config) {
    super();
    this.nodeQueueMap = new Map();
    this.taskRunningMap = new Map();
    this.flowModel = config.flowModel;
    this.recorder = config.recorder;
    this.currentTask = null;
  }
  /**
   * 添加一个任务到队列中。
   * 1. 由流程模型将所有的开始节点添加到队列中。
   * 2. 当一个节点执行完成后，将后续的节点添加到队列中。
   */
  public addTask(nodeParam: NodeParam) {
    const { executionId } = nodeParam;
    if (!this.nodeQueueMap.has(executionId)) {
      this.nodeQueueMap.set(executionId, []);
    }
    const currentTaskQueue = this.nodeQueueMap.get(executionId);
    currentTaskQueue.push(nodeParam);
  }
  /**
   * 调度器执行下一个任务
   * 1. 提供给流程模型，用户开始执行第一个任务。
   * 2. 内部任务执行完成后，调用此方法继续执行下一个任务。
   * 3. 当判断没有可以继续执行的任务后，触发流程结束事件。
   */
  public run(runParams: {
    executionId: string;
    nodeId?: string;
    taskId?: string;
  }) {
    const { executionId } = runParams;
    const currentNode = this.getNextNode(executionId);
    if (currentNode) {
      const taskId = createTaskId();
      const taskParam = {
        ...currentNode,
        taskId,
      };
      this.pushTaskToRunningMap(taskParam);
      this.exec(taskParam);
    } else if (!this.hasRunningTask(executionId)) {
      // 当一个流程在nodeQueueMap和taskRunningMap中都不存在执行的节点时，说明这个流程已经执行完成。
      this.emit(EVENT_INSTANCE_COMPLETE, {
        executionId,
        nodeId: runParams.nodeId,
        taskId: runParams.taskId,
        status: FlowStatus.COMPLETED,
      });
    }
  }
  /**
   * 恢复某个任务的执行。
   * 可以自定义节点手动实现流程中断，然后通过此方法恢复流程的执行。
   */
  public async resume(resumeParam: ResumeParam) {
    this.pushTaskToRunningMap({
      executionId: resumeParam.executionId,
      nodeId: resumeParam.nodeId,
      taskId: resumeParam.taskId,
    });
    const model = this.flowModel.createTask(resumeParam.nodeId);
    await model.resume({
      ...resumeParam,
      next: this.next.bind(this),
    });
  }
  // 流程执行过程中出错，停止执行
  stop(data) {
    console.log('stop', data);
  }
  private pushTaskToRunningMap(taskParam) {
    const { executionId, taskId } = taskParam;
    if (!this.taskRunningMap.has(executionId)) {
      const runningMap = new Map<string, TaskParam>();
      this.taskRunningMap.set(executionId, runningMap);
    }
    this.taskRunningMap.get(executionId).set(taskId, taskParam);
  }
  private removeTaskFromRunningMap(taskParam: TaskParam) {
    const { executionId, taskId } = taskParam;
    if (!taskId) return;
    const runningMap = this.taskRunningMap.get(executionId);
    if (!runningMap) return;
    runningMap.delete(taskId);
  }
  private hasRunningTask(executionId) {
    const runningMap = this.taskRunningMap.get(executionId);
    if (!runningMap) return false;
    if (runningMap.size === 0) {
      this.taskRunningMap.delete(executionId);
      return false;
    }
    return true;
  }
  private async exec(taskParam: TaskParam) {
    const model = this.flowModel.createTask(taskParam.nodeId);
    const execResult = await model.execute({
      executionId: taskParam.executionId,
      taskId: taskParam.taskId,
      nodeId: taskParam.nodeId,
      next: this.next.bind(this),
    });
    if (execResult && execResult.status === FlowStatus.INTERRUPTED) {
      this.interrupted({
        execResult,
        taskParam,
      });
      this.saveTaskResult({
        executionId: taskParam.executionId,
        nodeId: taskParam.nodeId,
        taskId: taskParam.taskId,
        nodeType: execResult.nodeType,
        properties: execResult.properties,
        outgoing: [],
        extraInfo: {
          status: execResult.status,
          detail: execResult.detail,
        },
      });
      this.removeTaskFromRunningMap(taskParam);
    }
  }
  private interrupted({
    execResult,
    taskParam,
  } : { execResult: ActionResult, taskParam: TaskParam}) {
    this.emit(EVENT_INSTANCE_INTERRUPTED, {
      executionId: taskParam.executionId,
      status: FlowStatus.INTERRUPTED,
      nodeId: taskParam.nodeId,
      taskId: taskParam.taskId,
      detail: execResult.detail,
    });
  }
  private cancel(taskParam: TaskParam) {
    // TODO: 流程执行异常中断
  }
  private async next(data: NextTaskParam) {
    if (data.outgoing && data.outgoing.length > 0) {
      data.outgoing.forEach((item) => {
        this.addTask({
          executionId: data.executionId,
          nodeId: item.target,
        });
      });
    }
    this.saveTaskResult(data);
    this.removeTaskFromRunningMap(data);
    this.run({
      executionId: data.executionId,
      nodeId: data.nodeId,
      taskId: data.taskId,
    });
  }
  private saveTaskResult(data: TaskResult) {
    this.recorder.addTask({
      executionId: data.executionId,
      taskId: data.taskId,
      nodeId: data.nodeId,
      nodeType: data.nodeType,
      timestamp: Date.now(),
      properties: data.properties,
    });
  }
  private getNextNode(executionId): NodeParam | null {
    const currentTaskQueue = this.nodeQueueMap.get(executionId);
    if (!currentTaskQueue || currentTaskQueue.length === 0) {
      return null;
    }
    const currentTask = currentTaskQueue.shift();
    return currentTask;
  }
}
