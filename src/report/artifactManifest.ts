import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Session } from '../session/store.js';

export interface SessionArtifactManifest {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  root: string;
  device: string | null;
  appId: string | null;
  sensitive: boolean;
  artifactCounts: Record<string, number>;
  files: Array<{
    uri: string;
    kind: string;
    label?: string;
    mime: string;
    path: string;
    bytes: number;
    sha256: string;
    createdAt: string;
  }>;
  missing: Array<{ uri: string; path: string; kind: string }>;
  environmentMutations: string[];
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function buildSessionArtifactManifest(session: Session): SessionArtifactManifest {
  const files: SessionArtifactManifest['files'] = [];
  const missing: SessionArtifactManifest['missing'] = [];
  const artifactCounts = session.artifacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});
  for (const a of session.artifacts) {
    if (!existsSync(a.path)) {
      missing.push({ uri: a.uri, path: a.path, kind: a.kind });
      continue;
    }
    const st = statSync(a.path);
    files.push({
      uri: a.uri,
      kind: a.kind,
      label: a.label,
      mime: a.mime,
      path: a.path,
      bytes: st.size,
      sha256: sha256(a.path),
      createdAt: new Date(a.createdAt).toISOString(),
    });
  }
  return {
    schemaVersion: 1,
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    root: session.root,
    device: session.device ?? null,
    appId: session.appId ?? null,
    sensitive: session.sensitive,
    artifactCounts,
    files,
    missing,
    environmentMutations: session.envChanges,
  };
}
