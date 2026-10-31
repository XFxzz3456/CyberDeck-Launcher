export type TaskStatus = "queued" | "running" | "success" | "error";

export type TaskKind =
  | "import"
  | "translate"
  | "scan"
  | "deploy"
  | "disable"
  | "uninstall"
  | "order"
  | "adopt";

export interface TaskItem {
  id: number;
  kind: TaskKind;
  title: string;
  detail?: string;
  status: TaskStatus;
  progress: number;
  error?: string;
  retryPaths?: string[];
  createdAt: number;
}

/** 活动流条目：任务完成（或无需任务行的轻操作）后落一条，
 *  回答「刚才那一下到底改了多少东西」。只展示最近 10 条。 */
export interface ActivityItem {
  id: number;
  kind: TaskKind | "system";
  title: string;
  detail?: string;
  at: number;
}
