export type StreamKind = "hls" | "file";
export type StreamAdapter = "png-prefix-mpegts";
export type ValidationStatus = "checking" | "playable" | "rejected";
export type StreamAccessMode = "portable" | "site-context";
export type PlayerContext = "top" | "embedded";
export type StreamObservation = "web-request" | "resource-timing" | "page-config";

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
  playerContext: PlayerContext;
  sourceDocumentUrl: string;
  url: string;
  displayUrl: string;
  kind: StreamKind;
  mime: string;
  firstSeenAt: number;
  observedVia?: StreamObservation;
  validationStatus: ValidationStatus;
  validationReason?: string;
  accessMode?: StreamAccessMode;
  validatedAt?: number;
  container?: string;
  exactBytes?: number;
  durationSeconds?: number;
  adapter?: StreamAdapter;
  variants: StreamVariant[];
}

export interface PlayerRequest {
  id: string;
  url: string;
  kind: StreamKind;
  label: string;
  adapter?: StreamAdapter;
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
  RESUME_SITE_PLAYER: "streambridge:resume-site-player",
  FRAME_ACTIVATED: "streambridge:frame-activated",
  OBSERVED_RESOURCE: "streambridge:observed-resource",
  PAGE_MEDIA_ACTIVATED: "streambridge:page-media-activated",
  MEDIA_STATE_CHANGED: "streambridge:media-state-changed",
  PLAYER_GET: "streambridge:player-get"
} as const;
