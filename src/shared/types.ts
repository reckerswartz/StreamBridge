export type StreamKind = "hls" | "file";
export type ValidationStatus = "checking" | "playable" | "rejected";
export type StreamAccessMode = "portable" | "site-context";

export interface StreamVariant {
  id: string;
  url: string;
  quality?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  estimatedBytes?: number;
}

export interface StreamCandidate {
  id: string;
  tabId: number;
  frameId: number;
  url: string;
  displayUrl: string;
  kind: StreamKind;
  mime: string;
  firstSeenAt: number;
  validationStatus: ValidationStatus;
  validationReason?: string;
  accessMode?: StreamAccessMode;
  validatedAt?: number;
  container?: string;
  exactBytes?: number;
  durationSeconds?: number;
  variants: StreamVariant[];
}

export interface PlayerRequest {
  id: string;
  url: string;
  kind: StreamKind;
  label: string;
  createdAt: number;
}

export interface TabStreamState {
  streams: StreamCandidate[];
}

export const MESSAGE = {
  LIST: "streambridge:list",
  CLEAR: "streambridge:clear",
  OVERLAY_UPDATE: "streambridge:overlay-update",
  OPEN_PLAYER: "streambridge:open-player",
  PLAYER_GET: "streambridge:player-get"
} as const;
