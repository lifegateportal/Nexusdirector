declare global {
  // eslint-disable-next-line no-var
  var __monitorState: MonitorState | undefined;
}

export type VerseQueueItem = {
  ref: string;
  text: string;
};

export type MonitorState = {
  ref: string;
  text: string;
  updatedAt: number;
  cleared: boolean;
  operatorQueue: VerseQueueItem[];
  queueMode: boolean;
};

function initial(): MonitorState {
  return { ref: "", text: "", updatedAt: 0, cleared: true, operatorQueue: [], queueMode: false };
}

export function getMonitorState(): MonitorState {
  if (!global.__monitorState) global.__monitorState = initial();
  // Normalize: guard against old state that predates the operatorQueue field
  if (!Array.isArray(global.__monitorState.operatorQueue)) {
    global.__monitorState.operatorQueue = [];
  }
  return global.__monitorState;
}

export function setMonitorDisplay(ref: string, text: string): void {
  const prev = getMonitorState();
  global.__monitorState = { ...prev, ref, text, updatedAt: Date.now(), cleared: false };
}

export function clearMonitorDisplay(): void {
  const prev = getMonitorState();
  global.__monitorState = { ...prev, ref: "", text: "", updatedAt: Date.now(), cleared: true };
}

export function enqueueForOperator(ref: string, text: string): void {
  const prev = getMonitorState();
  global.__monitorState = {
    ...prev,
    updatedAt: Date.now(),
    operatorQueue: [...prev.operatorQueue, { ref, text }],
  };
}

export function operatorGo(): void {
  const prev = getMonitorState();
  const [first, ...rest] = prev.operatorQueue;
  if (!first) return;
  global.__monitorState = {
    ...prev,
    ref: first.ref,
    text: first.text,
    cleared: false,
    updatedAt: Date.now(),
    operatorQueue: rest,
  };
}

export function operatorSkip(): void {
  const prev = getMonitorState();
  const [, ...rest] = prev.operatorQueue;
  global.__monitorState = { ...prev, updatedAt: Date.now(), operatorQueue: rest };
}

export function setQueueMode(enabled: boolean): void {
  const prev = getMonitorState();
  global.__monitorState = { ...prev, queueMode: enabled, updatedAt: Date.now() };
}
