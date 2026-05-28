import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { APPROVED_DIRECTORY_ROOTS } from './directory-policy.js';

const ES_CANDIDATE_PATHS = [
  process.env.ES_EXE_PATH,
  'C:\\Users\\prest\\bin\\es.exe',
  'C:\\Program Files\\Everything\\es.exe',
  'C:\\Program Files (x86)\\Everything\\es.exe',
  'es.exe',
];

const ES_TIMEOUT_MS = clampNumber(process.env.SEARCH_FILES_ES_TIMEOUT_MS, 3000, 500, 30000);
const ENABLE_FALLBACK = process.env.SEARCH_FILES_ENABLE_FALLBACK !== 'false';
const FALLBACK_TIMEOUT_MS = clampNumber(process.env.SEARCH_FILES_FALLBACK_TIMEOUT_MS, 5000, 500, 30000);
const FALLBACK_MAX_SCANNED = clampNumber(process.env.SEARCH_FILES_FALLBACK_MAX_SCANNED, 20000, 100, 200000);
const FALLBACK_MAX_DEPTH = clampNumber(process.env.SEARCH_FILES_FALLBACK_MAX_DEPTH, 8, 1, 32);

const EVERYTHING_NOT_READY_PATTERN = /ipc|window|database|not ready|not found/i;

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

interface EsRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  error?: string;
}

function runEs(esPath: string, args: string[], timeoutMs = ES_TIMEOUT_MS): Promise<EsRunResult> {
  return new Promise((resolve) => {
    const child = spawn(esPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: EsRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort. The caller receives a timeout either way.
      }
      finish({ ok: false, stdout, stderr, timedOut: true, exitCode: null });
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > 10 * 1024 * 1024) {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish({
          ok: false,
          stdout,
          stderr,
          timedOut: false,
          exitCode: null,
          error: 'es.exe output exceeded 10 MB',
        });
      }
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, timedOut: false, exitCode: code });
    });

    child.on('error', (error) => {
      finish({
        ok: false,
        stdout,
        stderr: stderr || error.message,
        timedOut: false,
        exitCode: null,
        error: error.message,
      });
    });
  });
}

function findEsExe(): string | undefined {
  for (const candidate of ES_CANDIDATE_PATHS) {
    if (!candidate) continue;
    if (candidate === 'es.exe' || fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function canonicalizeWindowsPath(input: string): string {
  const normalized = path.win32.resolve(input.trim());
  return normalized.replace(/[\\/]+$/, '');
}

function isUnderApprovedRoot(filePath: string): boolean {
  const canonical = canonicalizeWindowsPath(filePath).toLowerCase();
  for (const root of APPROVED_DIRECTORY_ROOTS) {
    const rootCanonical = canonicalizeWindowsPath(root.path).toLowerCase();
    if (canonical === rootCanonical || canonical.startsWith(`${rootCanonical}\\`)) {
      return true;
    }
  }
  return false;
}

function getFallbackRoots(requestedPath?: string): string[] {
  if (requestedPath?.trim()) {
    const canonical = canonicalizeWindowsPath(requestedPath);
    if (!isUnderApprovedRoot(canonical)) {
      throw new Error(`Search path is outside the approved directories: ${requestedPath}`);
    }
    return fs.existsSync(canonical) ? [canonical] : [];
  }

  return APPROVED_DIRECTORY_ROOTS
    .map((root) => canonicalizeWindowsPath(root.path))
    .filter((root, index, roots) => fs.existsSync(root) && roots.indexOf(root) === index);
}

function wildcardToRegExp(query: string): RegExp {
  const escaped = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesFallbackQuery(filePath: string, query: string): boolean {
  const basename = path.win32.basename(filePath);
  const trimmed = query.trim();
  if (!trimmed) return false;

  if (/[*?]/.test(trimmed)) {
    return wildcardToRegExp(trimmed).test(basename) || wildcardToRegExp(trimmed).test(filePath);
  }

  const needle = trimmed.toLowerCase();
  return basename.toLowerCase().includes(needle) || filePath.toLowerCase().includes(needle);
}

function isUnderSearchRoot(filePath: string, searchRoot?: string): boolean {
  if (!searchRoot) return true;
  const canonical = canonicalizeWindowsPath(filePath).toLowerCase();
  const root = canonicalizeWindowsPath(searchRoot).toLowerCase();
  return canonical === root || canonical.startsWith(`${root}\\`);
}

function executeFallbackSearch(query: string, maxResults: number, requestedPath?: string): SearchFilesResult {
  const started = Date.now();
  const roots = getFallbackRoots(requestedPath);
  const paths: string[] = [];
  let scanned = 0;
  let totalFound = 0;
  let stoppedByTimeout = false;
  let stoppedByScanLimit = false;

  const visit = (directory: string, depth: number) => {
    if (Date.now() - started > FALLBACK_TIMEOUT_MS) {
      stoppedByTimeout = true;
      return;
    }
    if (scanned >= FALLBACK_MAX_SCANNED) {
      stoppedByScanLimit = true;
      return;
    }
    if (depth > FALLBACK_MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (stoppedByTimeout || stoppedByScanLimit) return;
      const fullPath = path.win32.join(directory, entry.name);
      scanned += 1;

      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile() || !matchesFallbackQuery(fullPath, query)) continue;
      if (!isUnderApprovedRoot(fullPath)) continue;

      totalFound += 1;
      if (paths.length < maxResults) {
        paths.push(fullPath);
      }
    }
  };

  for (const root of roots) {
    if (stoppedByTimeout || stoppedByScanLimit) break;
    visit(root, 0);
  }

  return {
    query,
    backend: 'filesystem-fallback',
    ok: true,
    degraded: true,
    warning: 'Everything was unavailable, so a bounded filesystem fallback was used.',
    totalFound,
    returned: paths.length,
    paths,
    truncated: totalFound > paths.length || stoppedByTimeout || stoppedByScanLimit,
    diagnostics: {
      timeoutMs: FALLBACK_TIMEOUT_MS,
      maxScanned: FALLBACK_MAX_SCANNED,
      maxDepth: FALLBACK_MAX_DEPTH,
      scanned,
      stoppedByTimeout,
      stoppedByScanLimit,
      roots,
    },
  };
}

export interface SearchFilesArgs {
  query: string;
  maxResults?: number;
  path?: string;
}

export interface SearchFilesResult {
  query: string;
  backend: 'everything' | 'filesystem-fallback';
  ok: boolean;
  degraded?: boolean;
  warning?: string;
  errorCode?: string;
  message?: string;
  totalFound: number;
  returned: number;
  paths: string[];
  truncated: boolean;
  diagnostics?: Record<string, unknown>;
}

function unavailableResult(
  query: string,
  errorCode: string,
  message: string,
  diagnostics: Record<string, unknown>,
  requestedPath?: string,
  maxResults = 50
): SearchFilesResult {
  if (ENABLE_FALLBACK) {
    try {
      const fallback = executeFallbackSearch(query, maxResults, requestedPath);
      fallback.warning = `${message} ${fallback.warning}`;
      fallback.diagnostics = {
        everything: diagnostics,
        fallback: fallback.diagnostics,
      };
      return fallback;
    } catch (error: any) {
      diagnostics.fallbackError = error.message;
    }
  }

  return {
    query,
    backend: 'everything',
    ok: false,
    errorCode,
    message,
    totalFound: 0,
    returned: 0,
    paths: [],
    truncated: false,
    diagnostics,
  };
}

export async function executeSearchFiles(args: SearchFilesArgs): Promise<SearchFilesResult> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('Query is required');
  }

  const maxResults = Math.min(Math.max(1, Math.floor(Number(args.maxResults ?? 50))), 200);
  const requestedPath = typeof args.path === 'string' && args.path.trim() ? args.path : undefined;
  const requestedCanonicalPath = requestedPath ? canonicalizeWindowsPath(requestedPath) : undefined;
  if (requestedCanonicalPath && !isUnderApprovedRoot(requestedCanonicalPath)) {
    throw new Error(`Search path is outside the approved directories: ${requestedPath}`);
  }
  const esPath = findEsExe();

  if (!esPath) {
    return unavailableResult(
      query,
      'ES_NOT_FOUND',
      'es.exe (Everything CLI) was not found.',
      { esExeFound: false },
      requestedPath,
      maxResults
    );
  }

  const version = await runEs(esPath, ['-version'], 1500);
  if (!version.ok) {
    return unavailableResult(
      query,
      version.timedOut ? 'ES_VERSION_TIMEOUT' : 'ES_VERSION_FAILED',
      'es.exe was found but could not be verified quickly.',
      {
        esExeFound: true,
        esExePath: esPath,
        timeoutMs: 1500,
        version,
      },
      requestedPath,
      maxResults
    );
  }

  const esArgs = requestedCanonicalPath
    ? ['-path', requestedCanonicalPath, '-n', String(maxResults + 1), query]
    : ['-n', String(maxResults + 1), query];
  const result = await runEs(esPath, esArgs, ES_TIMEOUT_MS);
  const stderr = result.stderr.slice(0, 2000);

  if (result.timedOut) {
    return unavailableResult(
      query,
      'EVERYTHING_SEARCH_TIMEOUT',
      'Everything search timed out. Everything may not be ready or its IPC/database may be unavailable.',
      {
        esExeFound: true,
        esExePath: esPath,
        version: version.stdout.trim(),
        timeoutMs: ES_TIMEOUT_MS,
        searchTimedOut: true,
        stderr,
      },
      requestedPath,
      maxResults
    );
  }

  if (result.error || (!result.ok && result.exitCode !== 1) || EVERYTHING_NOT_READY_PATTERN.test(stderr)) {
    return unavailableResult(
      query,
      'EVERYTHING_NOT_READY',
      'Everything CLI is installed, but the Everything IPC/database is not ready.',
      {
        esExeFound: true,
        esExePath: esPath,
        version: version.stdout.trim(),
        exitCode: result.exitCode,
        stderr,
        error: result.error,
      },
      requestedPath,
      maxResults
    );
  }

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rawPaths = lines.slice(0, maxResults);
  const approvedPaths = rawPaths.filter((filePath) => (
    isUnderApprovedRoot(filePath) && isUnderSearchRoot(filePath, requestedCanonicalPath)
  ));

  return {
    query,
    backend: 'everything',
    ok: true,
    totalFound: lines.length,
    returned: approvedPaths.length,
    paths: approvedPaths,
    truncated: lines.length > maxResults,
    diagnostics: {
      esExePath: esPath,
      timeoutMs: ES_TIMEOUT_MS,
      version: version.stdout.trim(),
      filteredOutUnapproved: rawPaths.length - approvedPaths.length,
    },
  };
}
