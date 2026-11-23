import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Load an API resource with loading / error / reload state. */
export function useApi(url, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return setState({ data: null, error: null, loading: false });
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(url);
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

/** Run a mutation with busy + error state; returns the result or undefined on error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
