export type LogLevel = "init" | "info" | "success" | "warn" | "error" | "stream";
export type ModelHandle = "gemini" | "deepseek" | "claude" | "curator" | "manus";
export type PipelineStage = "idle" | "ingesting" | "reasoning" | "generating" | "producing" | "done" | "error";
export type ModelStatus = "active" | "standby" | "error";

export type LogEntry = {
  id: string;
  level: LogLevel;
  message: string;
  timestamp: string;
  model?: ModelHandle;
};

export type ModelState = {
  name: string;
  handle: ModelHandle;
  role: string;
  status: ModelStatus;
};
