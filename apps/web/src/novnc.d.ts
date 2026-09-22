// noVNC ships plain ES modules without type declarations. Only the surface the cloud console
// uses is declared here.
declare module "@novnc/novnc" {
  export interface RfbEventDetail { clean?: boolean; reason?: string; }
  export interface RfbEvent { detail?: RfbEventDetail; }
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    sendCtrlAltDel(): void;
    focus(): void;
    addEventListener(type: string, listener: (event: RfbEvent) => void): void;
    removeEventListener(type: string, listener: (event: RfbEvent) => void): void;
  }
}
