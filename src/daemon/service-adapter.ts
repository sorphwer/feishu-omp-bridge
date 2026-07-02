import * as launchd from './launchd';
import { launchAgentPlistPath, systemdUnitPath } from './paths';
import * as systemd from './systemd';

export interface ServiceResult {
  ok: boolean;
  stderr: string;
}

/** Some platforms' restart is sync (spawnSync), others are naturally
 * async. Adapter methods can return either; callers await. */
export type ServiceResultLike = ServiceResult | Promise<ServiceResult>;

/**
 * Platform-agnostic interface over OS service managers (launchd / systemd).
 * All methods are best-effort idempotent — calling stop()
 * on an already-stopped service returns ok=true.
 */
export interface ServiceAdapter {
  /** Display name used in error / status messages. */
  readonly platformName: string;

  /** Whether the service file (plist / unit / task) is on disk / registered. */
  fileExists(): boolean;

  /** Whether the service is currently running (process alive). */
  isRunning(): boolean;

  /** Path/name to the service definition (for status output). */
  servicePath(): string;

  /** Write or overwrite the service definition. */
  install(): Promise<void>;

  /** Start the service (enables autostart where applicable). */
  start(): ServiceResultLike;

  /** Stop the service. Does NOT disable autostart on its own. */
  stop(): ServiceResultLike;

  /** Stop + disable autostart. Used by `unregister` flow. */
  stopAndDisableAutostart(): ServiceResultLike;

  /** Restart the running service in place. */
  restart(): ServiceResultLike;

  /** Poll until the service is no longer running, or timeout. */
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;

  /** Remove the service definition from the OS. */
  deleteFile(): Promise<void>;

  /** Raw status output from the underlying tool, for downstream parsing. */
  describeStatus(): string;

  /**
   * Extract pid / last exit code from `describeStatus()` text. Returns
   * undefined for fields the platform doesn't expose or hasn't recorded yet.
   */
  parseStatus(text: string): { pid?: string; lastExit?: string };
}

function makeLaunchdAdapter(): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: launchd.plistExists,
    isRunning: launchd.isLoaded,
    servicePath: launchAgentPlistPath,
    install: launchd.writePlist,
    start: launchd.bootstrap,
    stop: launchd.bootout,
    // launchd has no separate "disable" — bootout already removes the
    // service from launchd, which also nukes KeepAlive / RunAtLoad.
    stopAndDisableAutostart: launchd.bootout,
    restart: launchd.kickstart,
    waitUntilStopped: launchd.waitUntilUnloaded,
    deleteFile: launchd.deletePlist,
    describeStatus: launchd.describeService,
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    fileExists: systemd.unitExists,
    isRunning: systemd.isActive,
    servicePath: systemdUnitPath,
    install: async () => {
      await systemd.writeUnit();
      // systemd needs daemon-reload after any unit file change.
      systemd.daemonReload();
    },
    start: systemd.enableAndStart,
    stop: systemd.stop,
    stopAndDisableAutostart: systemd.disableAndStop,
    restart: systemd.restart,
    waitUntilStopped: systemd.waitUntilInactive,
    deleteFile: async () => {
      await systemd.deleteUnit();
      systemd.daemonReload();
    },
    describeStatus: systemd.describeService,
    // `systemctl status` includes a "Main PID:" line and an "Active:"
    // line. There's no single "last exit code" field in the standard
    // output but the "Process: <pid> ExecStart=... status=<n>" line on
    // an inactive service exposes it.
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    }),
  };
}

/**
 * Return the right adapter for the current platform, or null if this OS
 * isn't supported. Callers should null-check and surface a friendly error.
 *
 * Windows (Task Scheduler) support was removed — its lack of a native
 * restart primitive and its divergent status/exit-code reporting made it
 * a poor fit to keep maintaining alongside launchd/systemd. Throws instead
 * of returning null so `win32` gets an explicit, actionable message instead
 * of the generic "unsupported OS" fallback.
 */
export function getServiceAdapter(): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter();
  if (process.platform === 'linux') return makeSystemdAdapter();
  if (process.platform === 'win32') {
    throw new Error(
      'Windows 守护进程支持已移除；请前台运行 `feishu-omp-bridge run`，或用 WSL + systemd。',
    );
  }
  return null;
}
