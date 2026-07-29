import { useCallback, useEffect, useRef, useState } from "react";

export type LogLevel = "info" | "ok" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  message: string;
};

const MAX_ENTRIES = 500;

export type ActivityLogger = (message: string, level?: LogLevel) => void;

export type ActivityLog = {
  logs: LogEntry[];
  running: boolean;
  elapsedMs: number;
  log: ActivityLogger;
  start: (label?: string) => void;
  stop: (finalMessage?: string, level?: LogLevel) => void;
  reset: () => void;
};

/**
 * Lightweight per-stage activity buffer with a live elapsed timer.
 * Keeps last 500 entries and mirrors to `console` in dev.
 */
export function useActivityLog(): ActivityLog {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTick(), [clearTick]);

  const log = useCallback<ActivityLogger>((message, level = "info") => {
    const entry: LogEntry = { ts: Date.now(), level, message };
    if (typeof console !== "undefined") {
      const fn =
        level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn.call(console, `[activity] ${message}`);
    }
    setLogs((prev) => {
      const next = prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : prev;
      return [...next, entry];
    });
  }, []);

  const start = useCallback(
    (label?: string) => {
      clearTick();
      startRef.current = performance.now();
      setElapsedMs(0);
      setRunning(true);
      setLogs(label ? [{ ts: Date.now(), level: "info", message: label }] : []);
      tickRef.current = setInterval(() => {
        if (startRef.current != null) {
          setElapsedMs(performance.now() - startRef.current);
        }
      }, 1000);
    },
    [clearTick],
  );

  const stop = useCallback(
    (finalMessage?: string, level: LogLevel = "ok") => {
      clearTick();
      if (startRef.current != null) {
        setElapsedMs(performance.now() - startRef.current);
      }
      setRunning(false);
      if (finalMessage) {
        setLogs((prev) => [...prev, { ts: Date.now(), level, message: finalMessage }]);
      }
    },
    [clearTick],
  );

  const reset = useCallback(() => {
    clearTick();
    startRef.current = null;
    setElapsedMs(0);
    setRunning(false);
    setLogs([]);
  }, [clearTick]);

  return { logs, running, elapsedMs, log, start, stop, reset };
}
