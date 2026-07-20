import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Pause, Play } from "lucide-react";
import { logsStreamUrl } from "./api";
import type { LogLine } from "./types";

const MAX_LINES = 500;

export function LogFeed() {
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Open the SSE stream only while the feed is expanded.
  useEffect(() => {
    if (!open) return;
    const es = new EventSource(logsStreamUrl);
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      let rec: LogLine | null = null;
      try {
        rec = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!rec || rec.type !== "log") return;
      const line = rec;
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(1) : prev.slice();
        next.push(line);
        return next;
      });
    };
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      setConnected(false);
    };
  }, [open]);

  // Auto-scroll to bottom on new lines unless paused.
  useEffect(() => {
    if (!paused && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, paused]);

  return (
    <section className={`panel logfeed${open ? "" : " logfeed--closed"}`}>
      <div className="panel__head logfeed__head">
        <button
          type="button"
          className="logfeed__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <h2 className="panel__title">Live log</h2>
        </button>
        {open && (
          <>
            <span
              className={`logfeed__conn ${connected ? "logfeed__conn--on" : ""}`}
              title={connected ? "Streaming" : "Disconnected"}
            />
            <button
              type="button"
              className="icon-btn logfeed__pause"
              onClick={() => setPaused((v) => !v)}
              title={paused ? "Resume" : "Pause"}
              aria-label={paused ? "Resume log feed" : "Pause log feed"}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </button>
          </>
        )}
      </div>

      {open && (
        <div className="panel__body logfeed__body" ref={bodyRef}>
          {lines.length === 0 && (
            <div className="panel__status">Waiting for log activity...</div>
          )}
          {lines.map((l, i) => (
            <div key={i} className={`logline logline--${l.level ?? "info"}`}>
              <span className="logline__subsystem">{l.subsystem ?? "-"}</span>
              <span className="logline__msg">{l.message ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
