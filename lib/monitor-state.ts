declare global {
  // eslint-disable-next-line no-var
  var __monitorState: MonitorState | undefined;
}

export type MonitorState = {
  ref: string;
  text: string;
  updatedAt: number;
  cleared: boolean;
};

export function getMonitorState(): MonitorState {
  if (!global.__monitorState) {
    global.__monitorState = { ref: "", text: "", updatedAt: 0, cleared: true };
  }
  return global.__monitorState;
}

export function setMonitorDisplay(ref: string, text: string): void {
  global.__monitorState = { ref, text, updatedAt: Date.now(), cleared: false };
}

export function clearMonitorDisplay(): void {
  global.__monitorState = { ref: "", text: "", updatedAt: Date.now(), cleared: true };
}
