import { useEffect } from 'react';

/** Sets the browser tab's title for the current page ("Cart · ScaleCart"). */
export function useTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ScaleCart` : 'ScaleCart';
  }, [title]);
}
