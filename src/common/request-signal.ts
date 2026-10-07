import type { Response } from 'express';
/** Stop scheduling later batch steps after the browser disconnects. */
export function requestSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  const close = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once('close', close);
  response.once('finish', () => response.off('close', close));
  return controller.signal;
}
