import { isAbsolute, join } from 'node:path';
import { loadProjectConfig } from '../cli/scan.js';

export type WdaMode = 'external' | 'managed';

export interface WdaConfig {
  mode: WdaMode;
  url: string;
  derivedDataPath: string;
  reuse: boolean;
  startupTimeoutMs: number;
  allowNonLoopbackUrls: string[];
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  developmentTeam?: string;
}

export const DEFAULT_WDA_CONFIG: WdaConfig = {
  mode: 'external',
  url: 'http://127.0.0.1:8100',
  derivedDataPath: '.swipium/cache/wda-derived-data',
  reuse: true,
  startupTimeoutMs: 120000,
  allowNonLoopbackUrls: [],
  capabilities: {},
  settings: {},
};

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

function developmentTeamFrom(wda?: Record<string, unknown>): string | undefined {
  if (typeof wda?.developmentTeam === 'string' && wda.developmentTeam.trim()) return wda.developmentTeam.trim();
  if (typeof process.env.DEVELOPMENT_TEAM === 'string' && process.env.DEVELOPMENT_TEAM.trim()) return process.env.DEVELOPMENT_TEAM.trim();
  if (typeof process.env.XCODE_DEVELOPMENT_TEAM === 'string' && process.env.XCODE_DEVELOPMENT_TEAM.trim())
    return process.env.XCODE_DEVELOPMENT_TEAM.trim();
  return undefined;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key.trim().length > 0));
}

export function loadWdaConfig(root: string): WdaConfig {
  const cfg = loadProjectConfig(root);
  const raw = (cfg?.ios as Record<string, unknown> | undefined)?.wda;
  if (!raw || typeof raw !== 'object') {
    const team = developmentTeamFrom();
    return {
      ...DEFAULT_WDA_CONFIG,
      derivedDataPath: resolvePath(root, DEFAULT_WDA_CONFIG.derivedDataPath),
      ...(team ? { developmentTeam: team } : {}),
    };
  }
  const wda = raw as Record<string, unknown>;
  const derivedDataPath =
    typeof wda.derivedDataPath === 'string' && wda.derivedDataPath.trim() ? wda.derivedDataPath : DEFAULT_WDA_CONFIG.derivedDataPath;
  const startupTimeoutMs =
    typeof wda.startupTimeoutMs === 'number' && Number.isFinite(wda.startupTimeoutMs) && wda.startupTimeoutMs > 0
      ? Math.floor(wda.startupTimeoutMs)
      : DEFAULT_WDA_CONFIG.startupTimeoutMs;
  const allowNonLoopbackUrls = Array.isArray(wda.allowNonLoopbackUrls)
    ? wda.allowNonLoopbackUrls.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.replace(/\/+$/, ''))
    : DEFAULT_WDA_CONFIG.allowNonLoopbackUrls;
  const team = developmentTeamFrom(wda);
  return {
    mode: wda.mode === 'managed' ? 'managed' : 'external',
    url: typeof wda.url === 'string' && wda.url.trim() ? wda.url : DEFAULT_WDA_CONFIG.url,
    derivedDataPath: resolvePath(root, derivedDataPath),
    reuse: typeof wda.reuse === 'boolean' ? wda.reuse : DEFAULT_WDA_CONFIG.reuse,
    startupTimeoutMs,
    allowNonLoopbackUrls,
    capabilities: plainObject(wda.capabilities),
    settings: plainObject(wda.settings),
    ...(team ? { developmentTeam: team } : {}),
  };
}

export function wdaSigningStatus(config: Pick<WdaConfig, 'developmentTeam'>): {
  configured: boolean;
  developmentTeam?: string;
  source: 'config-or-env' | 'missing';
  message: string;
} {
  return config.developmentTeam
    ? {
        configured: true,
        developmentTeam: config.developmentTeam,
        source: 'config-or-env',
        message: 'development team configured for managed WDA signing',
      }
    : { configured: false, source: 'missing', message: 'no development team configured; managed WDA signing may fail' };
}

export function wdaUrlAllowedByConfig(config: Pick<WdaConfig, 'allowNonLoopbackUrls'>, url: string): boolean {
  const normalized = url.replace(/\/+$/, '');
  return config.allowNonLoopbackUrls.some((allowed) => allowed.replace(/\/+$/, '') === normalized);
}
