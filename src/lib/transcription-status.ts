export const TRANSCRIPTION_STATUS_EVENT = "danibot:transcription-status";

declare global {
  interface WindowEventMap {
    "danibot:transcription-status": CustomEvent<{ configured: boolean }>;
  }
}

export function announceTranscriptionStatus(configured: boolean) {
  window.dispatchEvent(new CustomEvent(TRANSCRIPTION_STATUS_EVENT, { detail: { configured } }));
}
