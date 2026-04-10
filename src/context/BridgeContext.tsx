import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { defaultSettings, initialBridgeState } from '../shared/defaults';
import type { AppSettings, BridgeStateSnapshot } from '../shared/types';

interface BridgeContextValue {
  state: BridgeStateSnapshot;
  settings: AppSettings;
  isBooting: boolean;
  isSavingSettings: boolean;
  actionError: string | null;
  clearActionError: () => void;
  saveSettings: (settings: AppSettings) => Promise<void>;
  checkForAppUpdates: () => Promise<void>;
  installAppUpdate: () => Promise<void>;
  startWatching: () => Promise<void>;
  stopWatching: () => Promise<void>;
  browseDirectory: () => Promise<string | null>;
  retryJob: (jobId: string) => Promise<void>;
  refreshSystem: () => Promise<void>;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function BridgeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BridgeStateSnapshot>(initialBridgeState);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [isBooting, setIsBooting] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void Promise.all([window.mediaBridge.getState(), window.mediaBridge.loadSettings()])
      .then(([nextState, nextSettings]) => {
        if (!isMounted) {
          return;
        }

        setState(nextState);
        setSettings(nextSettings);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setActionError(getErrorMessage(error));
      })
      .finally(() => {
        if (isMounted) {
          setIsBooting(false);
        }
      });

    const unsubscribe = window.mediaBridge.onStateUpdate((nextState) => {
      startTransition(() => {
        setState(nextState);
      });
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const value: BridgeContextValue = {
    state,
    settings,
    isBooting,
    isSavingSettings,
    actionError,
    clearActionError: () => setActionError(null),
    saveSettings: async (nextSettings) => {
      setIsSavingSettings(true);
      try {
        const result = await window.mediaBridge.saveSettings(nextSettings);
        setSettings(result.settings);
        setState(result.state);
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      } finally {
        setIsSavingSettings(false);
      }
    },
    checkForAppUpdates: async () => {
      try {
        const nextState = await window.mediaBridge.checkForAppUpdates();
        setState(nextState);
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
    installAppUpdate: async () => {
      try {
        await window.mediaBridge.installAppUpdate();
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
    startWatching: async () => {
      try {
        const nextState = await window.mediaBridge.startWatching();
        setState(nextState);
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
    stopWatching: async () => {
      try {
        const nextState = await window.mediaBridge.stopWatching();
        setState(nextState);
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
    browseDirectory: async () => {
      try {
        const result = await window.mediaBridge.browseDirectory();
        setActionError(null);
        return result.path;
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
    retryJob: async (jobId) => {
      try {
        const nextState = await window.mediaBridge.retryJob(jobId);
        setState(nextState);
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
    refreshSystem: async () => {
      try {
        const nextState = await window.mediaBridge.refreshSystem();
        setState(nextState);
        setActionError(null);
      } catch (error) {
        setActionError(getErrorMessage(error));
        throw error;
      }
    },
  };

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge() {
  const value = useContext(BridgeContext);
  if (!value) {
    throw new Error('useBridge must be used inside BridgeProvider.');
  }

  return value;
}
