/**
 * The only global the renderer receives from the preload bridge.
 */

import type { VerticalLiveApi } from '../shared/types';

declare global {
  interface Window {
    readonly verticalLive: VerticalLiveApi;
  }
}

export {};
