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
  displayPrefs: MonitorDisplayPrefs;
};

export type MonitorBackgroundId = "black" | "midnight" | "sunrise" | "ocean" | "charcoal" | "transparent";
export type MonitorFontStyle = "serif" | "sans" | "display";
export type LowerThirdSize = "compact" | "standard" | "large";

export type MonitorDisplayPrefs = {
  layout: "center" | "lower-third";
  background: MonitorBackgroundId;
  fontStyle: MonitorFontStyle;
  lowerThirdBackground: "solid" | "glass" | "transparent";
  centerRefSize: number;
  centerVerseSize: number;
  lowerRefSize: number;
  lowerVerseSize: number;
  lowerThirdSize: LowerThirdSize;
};

export const DEFAULT_MONITOR_DISPLAY_PREFS: MonitorDisplayPrefs = {
  layout: "center",
  background: "black",
  fontStyle: "serif",
  lowerThirdBackground: "solid",
  centerRefSize: 34,
  centerVerseSize: 72,
  lowerRefSize: 18,
  lowerVerseSize: 40,
  lowerThirdSize: "standard",
};

function initial(): MonitorState {
  return {
    ref: "",
    text: "",
    updatedAt: 0,
    cleared: true,
    operatorQueue: [],
    queueMode: false,
    displayPrefs: { ...DEFAULT_MONITOR_DISPLAY_PREFS },
  };
}

export function getMonitorState(): MonitorState {
  if (!global.__monitorState) global.__monitorState = initial();
  // Normalize: guard against old state that predates the operatorQueue field
  if (!Array.isArray(global.__monitorState.operatorQueue)) {
    global.__monitorState.operatorQueue = [];
  }
  if (!global.__monitorState.displayPrefs) {
    global.__monitorState.displayPrefs = { ...DEFAULT_MONITOR_DISPLAY_PREFS };
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

export function setDisplayPrefs(partial: Partial<MonitorDisplayPrefs>): void {
  const prev = getMonitorState();
  global.__monitorState = {
    ...prev,
    updatedAt: Date.now(),
    displayPrefs: {
      ...DEFAULT_MONITOR_DISPLAY_PREFS,
      ...prev.displayPrefs,
      ...partial,
    },
  };
}
