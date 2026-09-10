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
      // Terminal palette in CSN tokens: the ink canvas, body type, and the
      // brand red wherever the log shouts. See data/config/colors.js.
      theme: {
        background: '#050505',
        foreground: '#d6d6d6',
        cursor: '#ee1518',
        black: '#141414',
        red: '#ff4d6d',
        green: '#2dd4a4',
        yellow: '#ffb84d',
        blue: '#8c8c8c',
        magenta: '#ee1518',
        cyan: '#b5b5b5',
        white: '#fbfef9',
        brightBlack: '#6b6b6b',
        brightRed: '#ff3d42',
        brightGreen: '#5fe3bb',
        brightYellow: '#ffcd7d',
        brightBlue: '#b5b5b5',
        brightMagenta: '#ff3d42',
        brightCyan: '#d6d6d6',
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
      <div className="flex items-center justify-between px-4 py-3 border-rule">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-section text-paper">Raw Pipeline Console</h2>
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-state-danger" />
            <span className="h-2.5 w-2.5 rounded-full bg-state-warn" />
            <span className="h-2.5 w-2.5 rounded-full bg-state-ok" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex rounded-full p-0.5 bg-ink-chip"
          >
            {filters.map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={`rounded-full px-3 py-1 font-condensed text-overline uppercase transition-colors ${
                  filter === item
                    ? 'shadow-sm bg-ink-panel text-paper'
                    : 'text-dim hover:text-paper'
                }`}
              >
                {item}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded-full p-2 text-muted transition-colors hover:bg-ink-chip hover:text-paper"
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
        <div className="p-2 bg-ink">
          <div ref={terminalContainerRef} className="h-96 w-full overflow-hidden rounded-control" />
        </div>
      )}
    </GlassCard>
  );
}
