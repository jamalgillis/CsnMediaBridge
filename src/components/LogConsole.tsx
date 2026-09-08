import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import GlassCard from './GlassCard';
import { useBridge } from '../context/BridgeContext';
import type { LogEntry } from '../shared/types';

const levelLabels: Record<LogEntry['level'], string> = {
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  debug: 'DBG',
};

const levelColors: Record<LogEntry['level'], string> = {
  info: '36',
  warn: '33',
  error: '31',
  debug: '90',
};

function stripAnsiAndControl(text: string) {
  let normalized = '';
  let index = 0;

  while (index < text.length) {
    const codePoint = text.charCodeAt(index);

    if (codePoint === 27) {
      index += 1;
      if (text[index] === '[') {
        index += 1;
        while (index < text.length) {
          const ansiCodePoint = text.charCodeAt(index);
          if (ansiCodePoint >= 64 && ansiCodePoint <= 126) {
            index += 1;
            break;
          }
          index += 1;
        }
      }
      continue;
    }

    const isControlCharacter =
      (codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      codePoint === 127;

    if (!isControlCharacter) {
      normalized += text[index];
    }

    index += 1;
  }

  return normalized;
}

export default function LogConsole() {
  const { state } = useBridge();
  const [isExpanded, setIsExpanded] = useState(true);
  const [filter, setFilter] = useState<LogEntry['level'] | 'all'>('all');

  const deferredLogs = useDeferredValue(state.logs);
  const filtered =
    filter === 'all'
      ? deferredLogs
      : deferredLogs.filter((entry) => entry.level === filter);

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const filters: Array<LogEntry['level'] | 'all'> = ['all', 'info', 'warn', 'error', 'debug'];

  useEffect(() => {
    if (!isExpanded || !terminalContainerRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: false,
      theme: {
        background: '#0a0b0e',
        foreground: '#cdd2da',
        cursor: '#7fc4e3',
        black: '#14161b',
        red: '#f87171',
        green: '#5ee6ad',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#7fc4e3',
        white: '#edeef1',
        brightBlack: '#5c6573',
        brightRed: '#fca5a5',
        brightGreen: '#6ee7b7',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#a8dcf2',
        brightWhite: '#ffffff',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);
    fitAddon.fit();

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(terminalContainerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isExpanded]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!isExpanded || !terminal) {
      return;
    }

    terminal.reset();

    if (filtered.length === 0) {
      terminal.writeln('\x1b[90mNo log lines yet. Start the watcher or refresh system checks to populate the console.\x1b[0m');
      fitAddonRef.current?.fit();
      return;
    }

    const orderedLogs = [...filtered].reverse();
    for (const log of orderedLogs) {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const message = stripAnsiAndControl(log.message);
      const source = stripAnsiAndControl(log.source);
      terminal.writeln(
        `\x1b[90m${time}\x1b[0m \x1b[${levelColors[log.level]}m[${levelLabels[log.level]}]\x1b[0m \x1b[90m${source}\x1b[0m ${message}`,
      );
    }

    terminal.scrollToBottom();
    fitAddonRef.current?.fit();
  }, [filtered, isExpanded]);

  return (
    <GlassCard padded={false} className="col-span-full">
      <div className="flex items-center justify-between px-4 py-3 border-surface-hairline">
        <div className="flex items-center gap-3">
          <h2 className="text-section text-ink">Raw Pipeline Console</h2>
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-secondary-500" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex rounded-full p-0.5 bg-surface-elevated"
          >
            {filters.map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={`rounded-full px-3 py-1 text-overline uppercase transition-colors ${
                  filter === item
                    ? 'shadow-sm bg-surface-card text-ink'
                    : 'text-ink-dim hover:text-ink'
                }`}
              >
                {item}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded-full p-2 text-ink-muted transition-colors hover:bg-surface-elevated hover:text-ink"
          >
            <svg
              className={`h-4 w-4 transition-transform ${isExpanded ? '' : 'rotate-180'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-2 bg-surface-canvas">
          <div ref={terminalContainerRef} className="h-96 w-full overflow-hidden rounded-control" />
        </div>
      )}
    </GlassCard>
  );
}
