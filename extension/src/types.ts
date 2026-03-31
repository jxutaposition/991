export interface DomContext {
  element_type: string;
  element_text: string;
  element_id: string | null;
  visible_text_nearby: string;
}

export interface CapturedEvent {
  sequence_number: number;
  event_type: "click" | "navigation" | "form_submit" | "copy_text";
  url: string;
  domain: string;
  dom_context: DomContext | null;
  screenshot_b64: string | null;
  timestamp: number;
}

export interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
  expertId: string;
  sequenceCounter: number;
  eventBuffer: CapturedEvent[];
}

export type MessageToBackground =
  | { type: "START_RECORDING"; expertId: string }
  | { type: "STOP_RECORDING" }
  | { type: "GET_STATE" }
  | { type: "CAPTURED_EVENT"; event: Omit<CapturedEvent, "sequence_number"> };

export type MessageFromBackground =
  | { type: "STATE"; state: RecordingState }
  | { type: "SESSION_STARTED"; sessionId: string }
  | { type: "SESSION_ENDED" }
  | { type: "ERROR"; message: string };
